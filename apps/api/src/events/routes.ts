/**
 * Two halves of the same pipe: a runner reports what an adapter did (`POST
 * /internal/attempts/:id/events`), and a browser watches a run live (`GET
 * /attempts/:id/events`, SSE). Both go through `@agentmesh/db`'s `appendEvent` for
 * durability; the SSE side also fans out through `event-bus.ts` so a subscriber sees an
 * event the moment it's ingested, not on the next poll.
 *
 * The two routes have different callers and therefore different auth: the ingest route
 * is presented a run token (the same mechanism `apps/proxy` resolves — see
 * `packages/db/src/run-grants.ts`), since a runner container has no session cookie and
 * shouldn't be given one; the SSE route sits behind `requireSession` like every other
 * browser-facing route, and additionally checks the requesting user owns the run the
 * attempt belongs to.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import {
  appendEvent,
  grantPermits,
  listEventsAfter,
  resolveRunToken,
  schema,
} from '@agentmesh/db';
import type { AgentEvent } from '@agentmesh/core';
import { requireSession } from '../auth/guard.js';
import { publish, subscribe } from './event-bus.js';

const { attempts, runs } = schema;

const AGENT_EVENT_TYPES = [
  'message_delta',
  'tool_call',
  'tool_result',
  'file_edit',
  'thinking',
  'error',
  'done',
] as const;

/**
 * Deliberately loose beyond `type`/`attemptId`/`timestamp`: this endpoint's caller is
 * our own runner entrypoint, not an arbitrary client, so the goal is catching a
 * programming mistake (wrong type tag, missing attemptId), not exhaustively modeling
 * the seven-variant union a second time — `AgentEvent` already does that once, in
 * `packages/core`, and a hand-kept zod mirror of it would drift the moment either one
 * changed without the other.
 */
const IngestEventBody = z
  .object({
    type: z.enum(AGENT_EVENT_TYPES),
    attemptId: z.string().uuid(),
    provider: z.string().min(1),
    timestamp: z.string().min(1),
  })
  .passthrough();

const RUN_TOKEN_HEADER = 'x-agentmesh-run-token';

export async function registerEventRoutes(
  server: FastifyInstance,
  db: Database,
): Promise<void> {
  server.post('/internal/attempts/:id/events', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    const token = request.headers[RUN_TOKEN_HEADER];
    if (typeof token !== 'string' || token === '') {
      return reply.code(401).send({ error: 'missing_run_token' });
    }

    const grant = await resolveRunToken(db, token);
    if (grant === null || grant.attemptId !== params.data.id) {
      return reply.code(401).send({ error: 'invalid_run_token' });
    }

    const body = IngestEventBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_event' });
    }
    if (
      body.data.attemptId !== grant.attemptId ||
      !grantPermits(grant, body.data.provider)
    ) {
      return reply.code(403).send({ error: 'event_scope_mismatch' });
    }

    const event = body.data as unknown as AgentEvent;
    await appendEvent(db, event);
    publish(event);

    return reply.code(202).send();
  });

  server.get(
    '/attempts/:id/events',
    { preHandler: requireSession(db) },
    async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }

      const [row] = await db
        .select({ userId: runs.userId })
        .from(attempts)
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .where(eq(attempts.id, params.data.id));
      if (!row || row.userId !== request.userId) {
        return reply.code(404).send({ error: 'not_found' });
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const write = (id: bigint | null, event: AgentEvent): void => {
        if (id !== null) reply.raw.write(`id: ${id.toString()}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Replay first — anything the runner already reported before this tab connected —
      // then subscribe, so nothing published between the replay query and the subscribe
      // call is silently missed. A duplicate at the seam (an event both replayed and
      // published) is possible but harmless: `id` lets the browser de-duplicate by it.
      const backlog = await listEventsAfter(db, params.data.id);
      for (const stored of backlog) write(stored.id, stored.event);

      const unsubscribe = subscribe(params.data.id, (event) => write(null, event));
      request.raw.on('close', unsubscribe);
    },
  );
}
