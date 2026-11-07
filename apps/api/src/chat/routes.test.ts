/**
 * Chat routes against a real Postgres — `FakeSandboxProvider`, no Docker daemon.
 * `POST /chats/:id/messages`'s happy path (a full provider round) isn't exercised
 * here: `chat-service.ts`'s `waitForAttempt` polls the DB for a real terminal
 * status, and nothing here simulates a runner ever reporting one — the same reason
 * `events/routes.test.ts` tests the ingest/SSE plumbing, not adapter behavior.
 * What's cheap and worth covering at this layer: auth, the credential preflight,
 * ownership isolation (including that `/messages` 404s — and creates nothing —
 * before ever touching the orchestrator), and `DELETE`'s cascade.
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
import { FakeSandboxProvider } from '../orchestrator/fake-sandbox-provider.js';

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
    'chat/routes.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('chat routes', () => {
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

  it('rejects every chat route without a session', async () => {
    app = await buildServer({ config, database: handle, sandbox: new FakeSandboxProvider() });

    const create = await app.server.inject({
      method: 'POST',
      url: '/chats',
      payload: { providers: ['ollama'] },
    });
    expect(create.statusCode).toBe(401);

    const list = await app.server.inject({ method: 'GET', url: '/chats' });
    expect(list.statusCode).toBe(401);
  });

  it('refuses to create a chat for a provider with no stored credential', async () => {
    const { cookie } = await freshApp();

    const response = await app!.server.inject({
      method: 'POST',
      url: '/chats',
      headers: { cookie },
      payload: { providers: ['claude'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'missing_credential' });
  });

  it('creates a chat, lists it, and reads it back with no messages yet', async () => {
    const { cookie } = await freshApp();

    const create = await app!.server.inject({
      method: 'POST',
      url: '/chats',
      headers: { cookie },
      payload: { providers: ['ollama'] },
    });
    expect(create.statusCode).toBe(201);
    const { chatId } = create.json() as { chatId: string };

    const list = await app!.server.inject({ method: 'GET', url: '/chats', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { chats: { id: string }[] }).chats.map((c) => c.id)).toContain(
      chatId,
    );

    const get = await app!.server.inject({
      method: 'GET',
      url: `/chats/${chatId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { providers: string[]; messages: unknown[]; runningAttempt: unknown };
    expect(body.providers).toEqual(['ollama']);
    expect(body.messages).toEqual([]);
    expect(body.runningAttempt).toBeNull();
  });

  it("404s reading, messaging, or deleting another user's chat, and creates nothing", async () => {
    const owner = await freshApp();
    const create = await app!.server.inject({
      method: 'POST',
      url: '/chats',
      headers: { cookie: owner.cookie },
      payload: { providers: ['ollama'] },
    });
    const { chatId } = create.json() as { chatId: string };

    const attackerEmail = `${randomUUID()}@example.test`;
    const { userId: attackerId } = await createUserWithPassword(
      handle.db,
      attackerEmail,
      'a genuinely long passphrase',
    );
    const attackerToken = await createSession(handle.db, attackerId);
    const attackerCookie = `${SESSION_COOKIE_NAME}=${attackerToken}`;

    const get = await app!.server.inject({
      method: 'GET',
      url: `/chats/${chatId}`,
      headers: { cookie: attackerCookie },
    });
    expect(get.statusCode).toBe(404);

    const message = await app!.server.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: { cookie: attackerCookie },
      payload: { content: 'hi' },
    });
    expect(message.statusCode).toBe(404);
    // The ownership check in chat-service.ts's sendChatMessage happens before any
    // message row or attempt is created — confirm nothing leaked through.
    const messages = await handle.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.chatId, chatId));
    expect(messages).toHaveLength(0);

    const del = await app!.server.inject({
      method: 'DELETE',
      url: `/chats/${chatId}`,
      headers: { cookie: attackerCookie },
    });
    expect(del.statusCode).toBe(404);

    const stillThere = await handle.db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.id, chatId));
    expect(stillThere).toHaveLength(1);
  });

  it('deletes a chat and cascades its messages away', async () => {
    const { cookie } = await freshApp();
    const create = await app!.server.inject({
      method: 'POST',
      url: '/chats',
      headers: { cookie },
      payload: { providers: ['ollama'] },
    });
    const { chatId } = create.json() as { chatId: string };
    await handle.db.insert(schema.chatMessages).values({
      chatId,
      turn: 0,
      role: 'user',
      content: 'hi',
    });

    const del = await app!.server.inject({
      method: 'DELETE',
      url: `/chats/${chatId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const get = await app!.server.inject({
      method: 'GET',
      url: `/chats/${chatId}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);

    const messages = await handle.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.chatId, chatId));
    expect(messages).toHaveLength(0);
  });

  it('404s deleting a chat that never existed', async () => {
    const { cookie } = await freshApp();

    const response = await app!.server.inject({
      method: 'DELETE',
      url: `/chats/${randomUUID()}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
