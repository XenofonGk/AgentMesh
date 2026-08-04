/**
 * Run grants against a real Postgres. Skipped without TEST_DATABASE_URL; refuses to
 * skip when one is configured but unreachable (see schema.test.ts for the reasoning).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { attempts, runs, users } from './schema.js';
import {
  grantPermits,
  issueRunToken,
  resolveRunToken,
  revokeRunGrant,
} from './run-grants.js';

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const client = postgres(CONNECTION, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 2 });
  }
}

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'run-grants.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('run grants', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshAttempt(
    provider = 'claude',
  ): Promise<{ userId: string; attemptId: string }> {
    const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
    const [run] = await handle.db
      .insert(runs)
      .values({ userId: user!.id, task: 'test task' })
      .returning({ id: runs.id });
    const [attempt] = await handle.db
      .insert(attempts)
      .values({ runId: run!.id, provider })
      .returning({ id: attempts.id });
    return { userId: user!.id, attemptId: attempt!.id };
  }

  it('resolves a token it issued', async () => {
    const { userId, attemptId } = await freshAttempt();
    const { token } = await issueRunToken(
      handle.db,
      { attemptId, userId, provider: 'claude' },
      60_000,
    );

    const grant = await resolveRunToken(handle.db, token);
    expect(grant?.userId).toBe(userId);
    expect(grant?.attemptId).toBe(attemptId);
    expect(grant?.provider).toBe('claude');
  });

  it('rejects a token it never issued', async () => {
    expect(await resolveRunToken(handle.db, 'not-a-real-token')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { userId, attemptId } = await freshAttempt();
    const { token } = await issueRunToken(
      handle.db,
      { attemptId, userId, provider: 'claude' },
      -1,
    );
    expect(await resolveRunToken(handle.db, token)).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const { userId, attemptId } = await freshAttempt();
    const { token } = await issueRunToken(
      handle.db,
      { attemptId, userId, provider: 'claude' },
      60_000,
    );
    await revokeRunGrant(handle.db, attemptId);
    expect(await resolveRunToken(handle.db, token)).toBeNull();
  });

  it("revoking one attempt does not affect another attempt's token", async () => {
    const a = await freshAttempt();
    const b = await freshAttempt();
    const tokenA = (
      await issueRunToken(
        handle.db,
        { attemptId: a.attemptId, userId: a.userId, provider: 'claude' },
        60_000,
      )
    ).token;
    const tokenB = (
      await issueRunToken(
        handle.db,
        { attemptId: b.attemptId, userId: b.userId, provider: 'claude' },
        60_000,
      )
    ).token;

    await revokeRunGrant(handle.db, a.attemptId);

    expect(await resolveRunToken(handle.db, tokenA)).toBeNull();
    expect(await resolveRunToken(handle.db, tokenB)).not.toBeNull();
  });

  it('stores no raw token in the database', async () => {
    const { userId, attemptId } = await freshAttempt();
    const { token } = await issueRunToken(
      handle.db,
      { attemptId, userId, provider: 'claude' },
      60_000,
    );

    const grant = await resolveRunToken(handle.db, token);
    expect(JSON.stringify(grant)).not.toContain(token);
  });

  it('grantPermits checks the exact provider the grant names', async () => {
    const { userId, attemptId } = await freshAttempt('claude');
    const { token } = await issueRunToken(
      handle.db,
      { attemptId, userId, provider: 'claude' },
      60_000,
    );
    const grant = await resolveRunToken(handle.db, token);

    expect(grantPermits(grant!, 'claude')).toBe(true);
    expect(grantPermits(grant!, 'gemini')).toBe(false);
  });
});
