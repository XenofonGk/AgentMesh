/**
 * Persistence for `AgentEvent` (`packages/core/src/agent-event.ts`) — see `schema.ts`'s
 * comment on `agentEvents` for why it's one JSON column, not one per variant.
 *
 * This is the seam a runner container's report of what an adapter did crosses into
 * durable storage, and the seam the API's SSE route reads back out of — `appendEvent`
 * for the former, `listEventsAfter` for the latter. Neither does anything with the
 * event's *meaning*; that's the UI's job once it has the union back.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import type { AgentEvent } from '@agentmesh/core';
import type { Database } from './client.js';
import { agentEvents } from './schema.js';

export type EventReviewStatus = 'pending' | 'approved' | 'rejected';

export interface StoredAgentEvent {
  /** Monotonic within an attempt — see schema.ts. What SSE resume cursors are made of. */
  id: bigint;
  event: AgentEvent;
  /** Diff review state — see schema.ts's comment on `agentEvents.reviewStatus`. */
  reviewStatus: EventReviewStatus;
}

export interface ReviewedEvent {
  id: bigint;
  attemptId: string;
  reviewStatus: EventReviewStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export async function appendEvent(db: Database, event: AgentEvent): Promise<void> {
  await db.insert(agentEvents).values({
    attemptId: event.attemptId,
    type: event.type,
    payload: event,
  });
}

/**
 * Everything after `afterId` (exclusive), oldest first — the shape both a fresh SSE
 * subscription (`afterId` omitted) and a reconnect (`afterId` = last id the client saw)
 * need. `payload` round-trips through `jsonb` losslessly for the JSON-safe shapes
 * `AgentEvent` is built from, so this is a cast, not a parse.
 */
export async function listEventsAfter(
  db: Database,
  attemptId: string,
  afterId?: bigint,
): Promise<StoredAgentEvent[]> {
  const rows = await db
    .select({
      id: agentEvents.id,
      payload: agentEvents.payload,
      reviewStatus: agentEvents.reviewStatus,
    })
    .from(agentEvents)
    .where(
      afterId === undefined
        ? eq(agentEvents.attemptId, attemptId)
        : and(eq(agentEvents.attemptId, attemptId), gt(agentEvents.id, afterId)),
    )
    .orderBy(asc(agentEvents.id));

  return rows.map((row) => ({
    id: row.id,
    event: row.payload as AgentEvent,
    reviewStatus: row.reviewStatus,
  }));
}

/**
 * Sets the review verdict for one `file_edit` event — the write side of the diff-review
 * UI (PLAN.md §5 Phase 3). Scoped to `type = 'file_edit'`: approving/rejecting anything
 * else is meaningless, and checking it here (not just in the route) means a caller that
 * skips the route's own guard still can't corrupt a non-diff event's row. Returns `null`
 * if the event doesn't exist, isn't a `file_edit`, or belongs to a different attempt
 * than the caller asserted — the route turns any of those into a 404, never leaking
 * which case it was.
 */
export async function setEventReviewStatus(
  db: Database,
  eventId: bigint,
  attemptId: string,
  status: Exclude<EventReviewStatus, 'pending'>,
  reviewedBy: string,
): Promise<ReviewedEvent | null> {
  const [row] = await db
    .update(agentEvents)
    .set({ reviewStatus: status, reviewedBy, reviewedAt: new Date() })
    .where(
      and(
        eq(agentEvents.id, eventId),
        eq(agentEvents.attemptId, attemptId),
        eq(agentEvents.type, 'file_edit'),
      ),
    )
    .returning({
      id: agentEvents.id,
      attemptId: agentEvents.attemptId,
      reviewStatus: agentEvents.reviewStatus,
      reviewedBy: agentEvents.reviewedBy,
      reviewedAt: agentEvents.reviewedAt,
    });

  return row ?? null;
}
