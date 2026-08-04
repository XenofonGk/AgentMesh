/**
 * Against a real Postgres and a real listening server — SSE only proves anything over
 * an actual socket, not `.inject()` (which resolves on response end, and this route's
 * response deliberately never ends while a client is subscribed).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createSession,
  createUserWithPassword,
  issueRunToken,
  runMigrations,
  schema,
  type DatabaseHandle,
} from '@agentmesh/db';
import { buildServer, type App } from '../server.js';
import { loadConfig } from '../config.js';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie.js';

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
    'routes.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('event routes', () => {
  let handle: DatabaseHandle;
  let app: App | undefined;
  const config = loadConfig({
    DATABASE_URL: CONNECTION,
    WEB_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
  });

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterEach(async () => {
    await app?.server.close();
    app = undefined;
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshAttempt(): Promise<{ userId: string; attemptId: string }> {
    const [user] = await handle.db
      .insert(schema.users)
      .values({})
      .returning({ id: schema.users.id });
    const [run] = await handle.db
      .insert(schema.runs)
      .values({ userId: user!.id, task: 'test task' })
      .returning({ id: schema.runs.id });
    const [attempt] = await handle.db
      .insert(schema.attempts)
      .values({ runId: run!.id, provider: 'claude' })
      .returning({ id: schema.attempts.id });
    return { userId: user!.id, attemptId: attempt!.id };
  }

  function messageDelta(attemptId: string, text: string): Record<string, unknown> {
    return {
      attemptId,
      provider: 'claude',
      timestamp: new Date().toISOString(),
      type: 'message_delta',
      role: 'assistant',
      text,
    };
  }

  describe('ingest (runner -> API)', () => {
    it('rejects a request with no run token', async () => {
      app = await buildServer({ config, database: handle });
      const { attemptId } = await freshAttempt();

      const response = await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attemptId}/events`,
        payload: messageDelta(attemptId, 'hi'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a token scoped to a different attempt', async () => {
      app = await buildServer({ config, database: handle });
      const { userId } = await freshAttempt();
      const { attemptId: otherAttempt } = await freshAttempt();
      const { token } = await issueRunToken(
        handle.db,
        { attemptId: otherAttempt, userId, provider: 'claude' },
        60_000,
      );

      const { attemptId } = await freshAttempt();
      const response = await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attemptId}/events`,
        headers: { 'x-agentmesh-run-token': token },
        payload: messageDelta(attemptId, 'hi'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts a valid event, persists it, and rejects a provider-scope mismatch', async () => {
      app = await buildServer({ config, database: handle });
      const { userId, attemptId } = await freshAttempt();
      const { token } = await issueRunToken(
        handle.db,
        { attemptId, userId, provider: 'claude' },
        60_000,
      );

      const mismatched = await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attemptId}/events`,
        headers: { 'x-agentmesh-run-token': token },
        payload: { ...messageDelta(attemptId, 'hi'), provider: 'gemini' },
      });
      expect(mismatched.statusCode).toBe(403);

      const response = await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attemptId}/events`,
        headers: { 'x-agentmesh-run-token': token },
        payload: messageDelta(attemptId, 'hi'),
      });
      expect(response.statusCode).toBe(202);
    });
  });

  describe('SSE (browser)', () => {
    async function freshSession(): Promise<{ userId: string; cookie: string }> {
      const email = `${randomUUID()}@example.test`;
      const { userId } = await createUserWithPassword(
        handle.db,
        email,
        'a genuinely long passphrase',
      );
      const token = await createSession(handle.db, userId);
      return { userId, cookie: `${SESSION_COOKIE_NAME}=${token}` };
    }

    it('404s for an attempt belonging to another user', async () => {
      app = await buildServer({ config, database: handle });
      await app.server.listen({ host: '127.0.0.1', port: 0 });
      const { attemptId } = await freshAttempt();
      const { cookie } = await freshSession();

      const address = app.server.server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const response = await fetch(
        `http://127.0.0.1:${address.port.toString()}/attempts/${attemptId}/events`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(404);
    });

    it('replays persisted events then streams live ones', async () => {
      app = await buildServer({ config, database: handle });
      await app.server.listen({ host: '127.0.0.1', port: 0 });

      const attempt = await freshAttempt();
      const token = await createSession(handle.db, attempt.userId);
      const cookie = `${SESSION_COOKIE_NAME}=${token}`;

      const { token: runToken } = await issueRunToken(
        handle.db,
        { attemptId: attempt.attemptId, userId: attempt.userId, provider: 'claude' },
        60_000,
      );
      await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attempt.attemptId}/events`,
        headers: { 'x-agentmesh-run-token': runToken },
        payload: messageDelta(attempt.attemptId, 'backlog'),
      });

      const address = app.server.server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${address.port.toString()}/attempts/${attempt.attemptId}/events`,
        { headers: { cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = '';
      const readChunk = async (): Promise<void> => {
        const { value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array());
      };

      await readChunk();
      expect(buffer).toContain('"text":"backlog"');

      await app.server.inject({
        method: 'POST',
        url: `/internal/attempts/${attempt.attemptId}/events`,
        headers: { 'x-agentmesh-run-token': runToken },
        payload: messageDelta(attempt.attemptId, 'live'),
      });
      await readChunk();
      expect(buffer).toContain('"text":"live"');

      controller.abort();
    });
  });
});
