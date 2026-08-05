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
import { appendEvent, listEventsAfter, setEventReviewStatus } from './events.js';

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

  function fileEdit(attemptId: string, path: string): AgentEvent {
    return {
      attemptId,
      provider: 'claude',
      timestamp: new Date().toISOString(),
      type: 'file_edit',
      path,
      diff: '--- a\n+++ b\n',
    };
  }

  describe('review status', () => {
    it('defaults every new event to pending', async () => {
      const attemptId = await freshAttempt();
      await appendEvent(handle.db, fileEdit(attemptId, 'a.ts'));

      const [stored] = await listEventsAfter(handle.db, attemptId);
      expect(stored?.reviewStatus).toBe('pending');
    });

    it('approves a file_edit event and records who reviewed it and when', async () => {
      const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
      const attemptId = await freshAttempt();
      await appendEvent(handle.db, fileEdit(attemptId, 'a.ts'));
      const [stored] = await listEventsAfter(handle.db, attemptId);

      const reviewed = await setEventReviewStatus(
        handle.db,
        stored!.id,
        attemptId,
        'approved',
        user!.id,
      );

      expect(reviewed).not.toBeNull();
      expect(reviewed?.reviewStatus).toBe('approved');
      expect(reviewed?.reviewedBy).toBe(user!.id);
      expect(reviewed?.reviewedAt).not.toBeNull();

      const [refetched] = await listEventsAfter(handle.db, attemptId);
      expect(refetched?.reviewStatus).toBe('approved');
    });

    it('rejects a file_edit event', async () => {
      const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
      const attemptId = await freshAttempt();
      await appendEvent(handle.db, fileEdit(attemptId, 'a.ts'));
      const [stored] = await listEventsAfter(handle.db, attemptId);

      const reviewed = await setEventReviewStatus(
        handle.db,
        stored!.id,
        attemptId,
        'rejected',
        user!.id,
      );
      expect(reviewed?.reviewStatus).toBe('rejected');
    });

    it('refuses to review an event of a non-file_edit type', async () => {
      const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
      const attemptId = await freshAttempt();
      await appendEvent(handle.db, messageDelta(attemptId, 'hi'));
      const [stored] = await listEventsAfter(handle.db, attemptId);

      const reviewed = await setEventReviewStatus(
        handle.db,
        stored!.id,
        attemptId,
        'approved',
        user!.id,
      );
      expect(reviewed).toBeNull();
    });

    it('returns null for an event id that does not belong to the given attempt', async () => {
      const [user] = await handle.db.insert(users).values({}).returning({ id: users.id });
      const attemptA = await freshAttempt();
      const attemptB = await freshAttempt();
      await appendEvent(handle.db, fileEdit(attemptA, 'a.ts'));
      const [stored] = await listEventsAfter(handle.db, attemptA);

      const reviewed = await setEventReviewStatus(
        handle.db,
        stored!.id,
        attemptB,
        'approved',
        user!.id,
      );
      expect(reviewed).toBeNull();
    });
  });
});
