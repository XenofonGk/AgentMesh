/**
 * Against a real Postgres — `jsonb` round-tripping and ordering are exactly the kind of
 * thing that looks right against a mock and isn't. Skipped without TEST_DATABASE_URL;
 * refuses to skip when one is configured but unreachable (see schema.test.ts).
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentmesh/core';
import { createDatabase, type DatabaseHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { attempts, runs, users } from './schema.js';
import { appendEvent, listEventsAfter } from './events.js';

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
    'events.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('agent event persistence', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshAttempt(): Promise<string> {
    const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
    const [run] = await handle.db
      .insert(runs)
      .values({ userId: user!.id, task: 'test task' })
      .returning({ id: runs.id });
    const [attempt] = await handle.db
      .insert(attempts)
      .values({ runId: run!.id, provider: 'claude' })
      .returning({ id: attempts.id });
    return attempt!.id;
  }

  function messageDelta(attemptId: string, text: string): AgentEvent {
    return {
      attemptId,
      provider: 'claude',
      timestamp: new Date().toISOString(),
      type: 'message_delta',
      role: 'assistant',
      text,
    };
  }

  it('round-trips an event through jsonb without losing any field', async () => {
    const attemptId = await freshAttempt();
    const event = messageDelta(attemptId, 'hello');

    await appendEvent(handle.db, event);
    const [stored] = await listEventsAfter(handle.db, attemptId);

    expect(stored?.event).toEqual(event);
  });

  it('returns events in the order they were appended', async () => {
    const attemptId = await freshAttempt();
    await appendEvent(handle.db, messageDelta(attemptId, 'first'));
    await appendEvent(handle.db, messageDelta(attemptId, 'second'));
    await appendEvent(handle.db, messageDelta(attemptId, 'third'));

    const stored = await listEventsAfter(handle.db, attemptId);
    expect(stored.map((row) => (row.event as { text: string }).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('listEventsAfter only returns events strictly after the given id — the resume cursor', async () => {
    const attemptId = await freshAttempt();
    await appendEvent(handle.db, messageDelta(attemptId, 'first'));
    const [afterFirst] = await listEventsAfter(handle.db, attemptId);
    await appendEvent(handle.db, messageDelta(attemptId, 'second'));
    await appendEvent(handle.db, messageDelta(attemptId, 'third'));

    const stored = await listEventsAfter(handle.db, attemptId, afterFirst!.id);
    expect(stored.map((row) => (row.event as { text: string }).text)).toEqual([
      'second',
      'third',
    ]);
  });

  it('scopes events to their own attempt', async () => {
    const attemptA = await freshAttempt();
    const attemptB = await freshAttempt();
    await appendEvent(handle.db, messageDelta(attemptA, 'for a'));
    await appendEvent(handle.db, messageDelta(attemptB, 'for b'));

    const storedA = await listEventsAfter(handle.db, attemptA);
    expect(storedA).toHaveLength(1);
    expect((storedA[0]!.event as { text: string }).text).toBe('for a');
  });
});
