/**
 * The chat HTTP surface: create a chat, list them, read one with its messages, send a
 * message (which runs the whole round-robin round server-side — see
 * `chat-service.ts`'s module doc for why that's synchronous). Behind `requireSession`
 * like every other authenticated route.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Database, Vault } from '@agentmesh/db';
import { schema } from '@agentmesh/db';
import { requireSession } from '../auth/guard.js';
import { missingCredentials } from '../credentials/check.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { sendChatMessage } from './chat-service.js';

const { chats, chatMessages, attempts } = schema;

const OPEN_STATUSES = ['pending', 'running'] as const;

const ProviderName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits, and hyphens');

const CreateChatBody = z.object({
  providers: z.array(ProviderName).min(1).max(8),
});

const SendMessageBody = z.object({
  content: z.string().min(1).max(16384),
});

export async function registerChatRoutes(
  server: FastifyInstance,
  db: Database,
  orchestrator: Orchestrator,
  proxyUrl: string,
  apiUrl: string,
  vault?: Vault,
): Promise<void> {
  const guard = { preHandler: requireSession(db) };

  server.post('/chats', guard, async (request, reply) => {
    const body = CreateChatBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const missing = await missingCredentials(vault, request.userId!, body.data.providers);
    if (missing.length > 0) {
      return reply.code(400).send({
        error: 'missing_credential',
        message: `No stored credential for: ${missing.join(', ')}. Add one in Settings first.`,
        providers: missing,
      });
    }

    const [chat] = await db
      .insert(chats)
      .values({ userId: request.userId!, providers: body.data.providers })
      .returning({ id: chats.id });
    if (!chat) {
      return reply.code(500).send({ error: 'failed_to_create_chat' });
    }

    return reply.code(201).send({ chatId: chat.id });
  });

  // `?before=<ISO timestamp>` pages backward — same cursor idiom as `GET /runs`.
  const ListChatsQuery = z.object({ before: z.string().datetime().optional() });
  server.get('/chats', guard, async (request, reply) => {
    const query = ListChatsQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query' });
    }

    const rows = await db
      .select({ id: chats.id, providers: chats.providers, createdAt: chats.createdAt })
      .from(chats)
      .where(
        query.data.before
          ? and(
              eq(chats.userId, request.userId!),
              lt(chats.createdAt, new Date(query.data.before)),
            )
          : eq(chats.userId, request.userId!),
      )
      .orderBy(desc(chats.createdAt))
      .limit(50);

    return reply.send({ chats: rows });
  });

  server.get('/chats/:id', guard, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    const [chat] = await db.select().from(chats).where(eq(chats.id, params.data.id));
    if (!chat || chat.userId !== request.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chat.id))
      .orderBy(asc(chatMessages.turn), asc(chatMessages.createdAt));

    // Lets the web UI offer a "Stop" button and show which provider is currently
    // replying while `POST /chats/:id/messages` is still in flight — that request
    // doesn't return until the whole round finishes, so this is the only way a
    // client watching the same chat can see live progress or cancel it.
    const [running] = await db
      .select({ id: attempts.id, provider: attempts.provider })
      .from(attempts)
      .where(and(eq(attempts.chatId, chat.id), inArray(attempts.status, OPEN_STATUSES)))
      .orderBy(desc(attempts.createdAt))
      .limit(1);

    return reply.send({
      id: chat.id,
      providers: chat.providers,
      createdAt: chat.createdAt,
      messages,
      runningAttempt: running ?? null,
    });
  });

  server.post('/chats/:id/messages', guard, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const body = SendMessageBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const newMessages = await sendChatMessage(db, orchestrator, {
      chatId: params.data.id,
      userId: request.userId!,
      content: body.data.content,
      proxyUrl,
      apiUrl,
    });
    if (!newMessages) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply.code(201).send({ messages: newMessages });
  });

  server.delete('/chats/:id', guard, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    const deleted = await orchestrator.deleteChat(params.data.id, request.userId!);
    if (!deleted) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply.code(204).send();
  });
}
