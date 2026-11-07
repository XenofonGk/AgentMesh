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

const { users, attempts, chats, agentEvents } = schema;

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

  async function freshChat(userId: string, providers: string[]): Promise<string> {
    const [chat] = await handle.db
      .insert(chats)
      .values({ userId, providers })
      .returning({ id: chats.id });
    return chat!.id;
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

  it('persists usage from a done event onto the attempt row', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'deepseek', image: 'agentmesh/deepseek:latest', command: ['run'] },
      ],
    });
    const attemptId = attemptIds[0]!;

    await orchestrator.finishAttempt(attemptId, {
      status: 'succeeded',
      usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0056, latencyMs: 2200 },
    });

    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.inputTokens).toBe(12);
    expect(row?.outputTokens).toBe(34);
    expect(row?.costUsd).toBe('0.005600');
    expect(row?.latencyMs).toBe(2200);
  });

  it('falls back to container-lifecycle latency when the adapter reports none', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [
        { provider: 'gemini', image: 'agentmesh/gemini:latest', command: ['run'] },
      ],
    });
    const attemptId = attemptIds[0]!;

    await orchestrator.finishAttempt(attemptId, {
      status: 'succeeded',
      usage: { inputTokens: null, outputTokens: null, costUsd: null, latencyMs: null },
    });

    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.latencyMs).not.toBeNull();
    expect(row?.latencyMs).toBeGreaterThanOrEqual(0);
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

  it('startChatAttempt creates a chat-keyed attempt with the same credential-free env as a run', async () => {
    const userId = await freshUser();
    const chatId = await freshChat(userId, ['ollama']);
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const attemptId = await orchestrator.startChatAttempt(
      chatId,
      userId,
      'hello',
      'http://proxy:3002',
      'http://api:3001',
      { provider: 'ollama', image: 'agentmesh/ollama:latest', command: ['run'] },
    );

    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.chatId).toBe(chatId);
    expect(row?.runId).toBeNull();
    expect(row?.status).toBe('running');

    const record = [...sandbox.sandboxes.values()][0]!;
    expect(record.spec.networks).toEqual(['internal']);
    expect(Object.keys(record.spec.env)).toEqual([
      'AGENTMESH_RUN_TOKEN',
      'AGENTMESH_PROXY_URL',
      'AGENTMESH_API_URL',
      'AGENTMESH_ATTEMPT_ID',
      'AGENTMESH_PROVIDER',
      'AGENTMESH_TASK',
    ]);
  });

  it('cancelAttempt stops a running run-attempt, tearing it down and publishing a synthetic done event', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [{ provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] }],
    });
    const attemptId = attemptIds[0]!;
    const containerId = [...sandbox.sandboxes.values()][0]!.id;

    const result = await orchestrator.cancelAttempt(attemptId, userId);

    expect(result).toBe('cancelled');
    expect(sandbox.sandboxes.get(containerId)?.destroyed).toBe(true);
    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('cancelled');

    // No runner is alive to report its own `done` event for a cancelled attempt — the
    // SSE stream (and any browser watching it) only learns the attempt ended if this
    // method synthesizes one itself.
    const events = await handle.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.attemptId, attemptId));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('done');
    expect((events[0]?.payload as { outcome: string }).outcome).toBe('cancelled');
  });

  it('cancelAttempt stops a running chat-attempt the same way', async () => {
    const userId = await freshUser();
    const chatId = await freshChat(userId, ['ollama']);
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const attemptId = await orchestrator.startChatAttempt(
      chatId,
      userId,
      'hello',
      'http://proxy:3002',
      'http://api:3001',
      { provider: 'ollama', image: 'agentmesh/ollama:latest', command: ['run'] },
    );

    const result = await orchestrator.cancelAttempt(attemptId, userId);

    expect(result).toBe('cancelled');
    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('cancelled');
  });

  it('cancelAttempt refuses to cancel — or even confirm the existence of — another user\'s attempt', async () => {
    const owner = await freshUser();
    const attacker = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId: owner,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [{ provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] }],
    });
    const attemptId = attemptIds[0]!;

    const result = await orchestrator.cancelAttempt(attemptId, attacker);

    expect(result).toBe('not_found');
    expect(sandbox.destroyCallCount).toBe(0);
    const [row] = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(row?.status).toBe('running');
  });

  it('cancelAttempt reports already_terminal rather than re-finishing a done attempt', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [{ provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] }],
    });
    const attemptId = attemptIds[0]!;
    await orchestrator.finishAttempt(attemptId, { status: 'succeeded' });

    const result = await orchestrator.cancelAttempt(attemptId, userId);

    expect(result).toBe('already_terminal');
  });

  it('deleteRun cancels any open attempt first, then cascades the row and its events away', async () => {
    const userId = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { runId, attemptIds } = await orchestrator.startRun({
      userId,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [{ provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] }],
    });
    const attemptId = attemptIds[0]!;
    const containerId = [...sandbox.sandboxes.values()][0]!.id;

    const deleted = await orchestrator.deleteRun(runId, userId);

    expect(deleted).toBe(true);
    expect(sandbox.sandboxes.get(containerId)?.destroyed).toBe(true);
    const attemptRows = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(attemptRows).toHaveLength(0);
  });

  it('deleteRun refuses another user\'s run', async () => {
    const owner = await freshUser();
    const attacker = await freshUser();
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const { runId, attemptIds } = await orchestrator.startRun({
      userId: owner,
      task: 'do the thing',
      proxyUrl: 'http://proxy:3002',
      apiUrl: 'http://api:3001',
      attempts: [{ provider: 'claude', image: 'agentmesh/claude:latest', command: ['run'] }],
    });

    const deleted = await orchestrator.deleteRun(runId, attacker);

    expect(deleted).toBe(false);
    const attemptRows = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptIds[0]!));
    expect(attemptRows).toHaveLength(1);
  });

  it('deleteChat cancels any open attempt first, then cascades the chat, its attempts, and its messages away', async () => {
    const userId = await freshUser();
    const chatId = await freshChat(userId, ['ollama']);
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const attemptId = await orchestrator.startChatAttempt(
      chatId,
      userId,
      'hello',
      'http://proxy:3002',
      'http://api:3001',
      { provider: 'ollama', image: 'agentmesh/ollama:latest', command: ['run'] },
    );
    const containerId = [...sandbox.sandboxes.values()][0]!.id;

    const deleted = await orchestrator.deleteChat(chatId, userId);

    expect(deleted).toBe(true);
    expect(sandbox.sandboxes.get(containerId)?.destroyed).toBe(true);
    const attemptRows = await handle.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    expect(attemptRows).toHaveLength(0);
    const chatRows = await handle.db.select().from(chats).where(eq(chats.id, chatId));
    expect(chatRows).toHaveLength(0);
  });

  it('deleteChat refuses another user\'s chat', async () => {
    const owner = await freshUser();
    const attacker = await freshUser();
    const chatId = await freshChat(owner, ['ollama']);
    const sandbox = new FakeSandboxProvider();
    const orchestrator = new Orchestrator(handle.db, sandbox);

    const deleted = await orchestrator.deleteChat(chatId, attacker);

    expect(deleted).toBe(false);
    const chatRows = await handle.db.select().from(chats).where(eq(chats.id, chatId));
    expect(chatRows).toHaveLength(1);
  });
});
