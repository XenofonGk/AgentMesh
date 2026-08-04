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
 *
 * The ingest route is also the only signal the API has that an attempt is over: a
 * `done` event is what tells `Orchestrator.finishAttempt` to destroy the sandbox and
 * revoke its run grant (see `orchestrator.ts`'s own doc comment on why that's
 * idempotent — this and the orchestrator's wall-clock timeout can both fire for the
 * same attempt).
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
  setEventReviewStatus,
} from '@agentmesh/db';
import type { AgentEvent } from '@agentmesh/core';
import { requireSession } from '../auth/guard.js';
import { publish, subscribe } from './event-bus.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';

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
  webOrigin: string,
  orchestrator?: Orchestrator,
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

    if (event.type === 'done' && orchestrator) {
      await orchestrator.finishAttempt(event.attemptId, {
        status: event.outcome,
      });
    }

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

      // Writing straight to `reply.raw` bypasses Fastify's own reply pipeline —
      // `@fastify/cors`'s hook runs on `onSend`, which a raw response never triggers,
      // so its headers have to be set by hand here or the browser blocks the response
      // outright (an `EventSource` with `withCredentials: true` requires an explicit
      // origin, never `*`, plus `Access-Control-Allow-Credentials`).
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': webOrigin,
        'access-control-allow-credentials': 'true',
      });

      // `reviewStatus` rides alongside the event, not inside it: it's API/DB metadata
      // about an event (see schema.ts on `agentEvents.reviewStatus`), not part of
      // `AgentEvent` itself, which CLAUDE.md forbids widening locally. Sent here purely
      // so a reconnecting/reloading browser sees prior review verdicts without a second
      // round trip; the diff-review UI reads it, nothing else needs to.
      const write = (
        id: bigint | null,
        event: AgentEvent,
        reviewStatus: 'pending' | 'approved' | 'rejected',
      ): void => {
        if (id !== null) reply.raw.write(`id: ${id.toString()}\n`);
        reply.raw.write(`data: ${JSON.stringify({ ...event, reviewStatus })}\n\n`);
      };

      // Replay first — anything the runner already reported before this tab connected —
      // then subscribe, so nothing published between the replay query and the subscribe
      // call is silently missed. A duplicate at the seam (an event both replayed and
      // published) is possible but harmless: `id` lets the browser de-duplicate by it.
      const backlog = await listEventsAfter(db, params.data.id);
      for (const stored of backlog) write(stored.id, stored.event, stored.reviewStatus);

      // A freshly published (not-yet-persisted-when-read) event is always `pending` —
      // that's the column default, and nothing reviews an event before it's ingested.
      const unsubscribe = subscribe(params.data.id, (event) =>
        write(null, event, 'pending'),
      );
      request.raw.on('close', unsubscribe);
    },
  );

  const ReviewParams = z.object({
    id: z.string().uuid(),
    eventId: z.string().regex(/^\d+$/, 'must be a positive integer'),
  });
  const ReviewBody = z.object({
    status: z.enum(['approved', 'rejected']),
  });

  server.patch(
    '/attempts/:id/events/:eventId/review',
    { preHandler: requireSession(db) },
    async (request, reply) => {
      const params = ReviewParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_id' });
      }

      const body = ReviewBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const [row] = await db
        .select({ userId: runs.userId })
        .from(attempts)
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .where(eq(attempts.id, params.data.id));
      if (!row || row.userId !== request.userId) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const reviewed = await setEventReviewStatus(
        db,
        BigInt(params.data.eventId),
        params.data.id,
        body.data.status,
        request.userId!,
      );
      if (reviewed === null) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return reply.send({
        eventId: reviewed.id.toString(),
        reviewStatus: reviewed.reviewStatus,
        reviewedAt: reviewed.reviewedAt?.toISOString() ?? null,
      });
    },
  );
}
