/**
 * Orchestrator lifecycle against a real Postgres and a `FakeSandboxProvider` — no
 * Docker daemon needed here; `docker-sandbox-provider.ts` is exercised separately, by
 * hand against a real daemon, since spinning up containers in CI is its own cost.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  resolveRunToken,
  schema,
  type DatabaseHandle,
} from '@agentmesh/db';
import { runMigrations } from '@agentmesh/db';
import { FakeSandboxProvider } from './fake-sandbox-provider.js';
import { Orchestrator } from './orchestrator.js';

const { users, attempts } = schema;

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const handle = createDatabase(CONNECTION);
  try {
    return await handle.ping();
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'orchestrator.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('Orchestrator', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshUser(): Promise<string> {
    const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
    return user!.id;
  }

  it('fans a run out into one attempt per provider, each with its own container and token', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const result = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] },
        { provider: 'codex', image: 'agentmesh/codex:latest', command: ['run'] },
      ],
    });

    expect(result.attemptIds).toHaveLength(2);
    expect(sandbox.sandboxes.size).toBe(2);

    const rows = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, result.runId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('running');
      expect(row.containerId).not.toBeNull();
    }

    // Each attempt's container only ever saw a run token, never a credential.
    for (const record of sandbox.sandboxes.values()) {
      expect(record.spec.networks).toEqual(['internal']);
      expect(Object.keys(record.spec.env)).toEqual([
        'AGENTMESH_RUN_TOKEN',
        'AGENTMESH_PROXY_URL',
        'AGENTMESH_API_URL',
        'AGENTMESH_ATTEMPT_ID',
        'AGENTMESH_PROVIDER',
        'AGENTMESH_TASK',
      ]);
      const token = record.spec.env['AGENTMESH_RUN_TOKEN']!;
      const grant = await resolveRunToken(handle.db, token);
      expect(grant).not.toBeNull();
    }
  });

  it('destroys the sandbox and revokes the token when an attempt finishes', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] },
      ],
    });
    const attemptId = attemptIds[0]!;
    const containerId = [...sandbox.sandboxes.values()][0]!.id;
    const token = [...sandbox.sandboxes.values()][0]!.spec.env['AGENTMESH_RUN_TOKEN']!;

    await orchestrator.finishAttempt(attemptId, { status: 'succeeded' });

    expect(sandbox.sandboxes.get(containerId)?.destroyed).toBe(true);
    expect(await resolveRunToken(handle.db, token)).toBeNull();

    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('succeeded');
    expect(row?.completedAt).not.toBeNull();
  });

  it('finishAttempt is idempotent — a second call cannot clobber the first outcome', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] },
      ],
    });
    const attemptId = attemptIds[0]!;

    await orchestrator.finishAttempt(attemptId, { status: 'succeeded' });
    // A timeout racing in after the done event already won — must not overwrite it.
    await orchestrator.finishAttempt(attemptId, {
      status: 'timed_out',
      errorMessage: 'attempt exceeded its wall-clock timeout',
    });

    expect(sandbox.destroyCallCount).toBe(1);
    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('succeeded');
    expect(row?.errorMessage).toBeNull();
  });

  it('times out and tears down an attempt that never reports done', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    // A real, tiny timeout rather than faked timers: this is an integration test
    // against real Postgres, and faking global timers stalls the driver's own
    // internals along with the one timer the test actually wants to fast-forward.
    const orchestrator = new Orchestrator(handle.db, sandbox, 20);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] },
      ],
    });
    const attemptId = attemptIds[0]!;

    // Wall-clock enforcement lives in the orchestrator, not DockerSandboxProvider — see
    // packages/core/src/sandbox.ts's own doc comment on RunSpec.timeoutMs. This is the
    // only thing that ever tears down a container whose runner crashed silently before
    // reporting a done event.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sandbox.destroyCallCount).toBe(1);
    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('timed_out');
  });
});
