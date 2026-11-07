/**
 * `/runs` HTTP surface against a real Postgres and `FakeSandboxProvider`. Covers what
 * `orchestrator.test.ts` doesn't: auth, request validation, and ownership isolation at
 * the route layer (not just the `Orchestrator` methods those routes call).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSession,
  createUserWithPassword,
  runMigrations,
  schema,
  type DatabaseHandle,
} from '@agentmesh/db';
import { buildServer, type App } from '../server.js';
import { loadConfig } from '../config.js';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie.js';
import { FakeSandboxProvider } from './fake-sandbox-provider.js';

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const probe = createDatabase(CONNECTION);
  try {
    return await probe.ping();
  } finally {
    await probe.close();
  }
}

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'orchestrator/routes.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('run routes', () => {
  let handle: DatabaseHandle;
  let app: App | undefined;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
    config = loadConfig({
      DATABASE_URL: CONNECTION,
      WEB_ORIGIN: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    });
  });

  afterEach(async () => {
    await app?.server.close();
    app = undefined;
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshApp(): Promise<{ app: App; cookie: string; userId: string }> {
    const built = await buildServer({
      config,
      database: handle,
      sandbox: new FakeSandboxProvider(),
    });
    app = built;

    const email = `${randomUUID()}@example.test`;
    const { userId } = await createUserWithPassword(
      handle.db,
      email,
      'a genuinely long passphrase',
    );
    const token = await createSession(handle.db, userId);
    return { app: built, cookie: `${SESSION_COOKIE_NAME}=${token}`, userId };
  }

  async function freshRun(userId: string, task = 'test task'): Promise<string> {
    const [run] = await handle.db
      .insert(schema.runs)
      .values({ userId, task })
      .returning({ id: schema.runs.id });
    return run!.id;
  }

  it('rejects every run route without a session', async () => {
    app = await buildServer({ config, database: handle, sandbox: new FakeSandboxProvider() });

    expect((await app.server.inject({ method: 'GET', url: '/runs' })).statusCode).toBe(401);
    const runId = await freshRun(
      (await createUserWithPassword(handle.db, `${randomUUID()}@example.test`, 'x'.repeat(20)))
        .userId,
    );
    expect(
      (await app.server.inject({ method: 'DELETE', url: `/runs/${runId}` })).statusCode,
    ).toBe(401);
  });

  it('lists only the caller\'s runs, newest first', async () => {
    const { cookie, userId } = await freshApp();
    const first = await freshRun(userId, 'older');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await freshRun(userId, 'newer');
    await freshRun(
      (await createUserWithPassword(handle.db, `${randomUUID()}@example.test`, 'x'.repeat(20)))
        .userId,
      'someone else entirely',
    );

    const response = await app!.server.inject({
      method: 'GET',
      url: '/runs',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(ids).toEqual([second, first]);
  });

  it('?before pages backward, excluding the cursor run and anything newer than it', async () => {
    const { cookie, userId } = await freshApp();
    const oldest = await freshRun(userId, 'oldest');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const middle = await freshRun(userId, 'middle');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newest = await freshRun(userId, 'newest');
    const [cursorRow] = await handle.db
      .select({ createdAt: schema.runs.createdAt })
      .from(schema.runs)
      .where(eq(schema.runs.id, newest));

    // A client that already has "newest" asks for everything before it — page two.
    const response = await app!.server.inject({
      method: 'GET',
      url: `/runs?before=${cursorRow!.createdAt.toISOString()}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const ids = (response.json() as { runs: { id: string }[] }).runs.map((r) => r.id);
    expect(ids).toEqual([middle, oldest]);
  });

  it("404s deleting another user's run, and leaves it in place", async () => {
    const owner = await freshApp();
    const runId = await freshRun(owner.userId);
    const attackerEmail = `${randomUUID()}@example.test`;
    const { userId: attackerId } = await createUserWithPassword(
      handle.db,
      attackerEmail,
      'a genuinely long passphrase',
    );
    const attackerToken = await createSession(handle.db, attackerId);

    const response = await app!.server.inject({
      method: 'DELETE',
      url: `/runs/${runId}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${attackerToken}` },
    });

    expect(response.statusCode).toBe(404);
    const stillThere = await handle.db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId));
    expect(stillThere).toHaveLength(1);
  });

  it('deletes the caller\'s own run, cascading its attempts', async () => {
    const { cookie, userId } = await freshApp();
    const runId = await freshRun(userId);
    await handle.db
      .insert(schema.attempts)
      .values({ runId, provider: 'claude', status: 'succeeded' });

    const response = await app!.server.inject({
      method: 'DELETE',
      url: `/runs/${runId}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(204);
    const runRows = await handle.db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(runRows).toHaveLength(0);
    const attemptRows = await handle.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.runId, runId));
    expect(attemptRows).toHaveLength(0);
  });

  it('404s deleting a run that never existed', async () => {
    const { cookie } = await freshApp();

    const response = await app!.server.inject({
      method: 'DELETE',
      url: `/runs/${randomUUID()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
