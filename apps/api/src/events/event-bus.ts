/**
 * In-process pub/sub for live `AgentEvent`s, keyed by attempt id. This is what lets the
 * SSE route (`routes.ts`) push an event to a subscribed browser the moment the ingest
 * route receives it from a runner, instead of the browser polling the DB.
 *
 * Deliberately in-process, not Postgres LISTEN/NOTIFY or a message queue: this is a
 * self-hosted, single-API-process deployment (CLAUDE.md's anti-goals rule out
 * multi-tenant/horizontally-scaled infrastructure), so there is exactly one process
 * that could ever have a subscriber for a given attempt, and it's this one.
 */
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@agentmesh/core';

const emitter = new EventEmitter();
// Every attempt with an open SSE tab is a listener; the default limit (10) is a
// leak-detection heuristic for a single emitter shared by unrelated concerns, not a
// real ceiling here — each attempt's events go out under its own event name.
emitter.setMaxListeners(0);

function eventName(attemptId: string): string {
  return `attempt:${attemptId}`;
}

export function publish(event: AgentEvent): void {
  emitter.emit(eventName(event.attemptId), event);
}

/** Returns an unsubscribe function — always call it when the SSE connection closes. */
export function subscribe(
  attemptId: string,
  listener: (event: AgentEvent) => void,
): () => void {
  emitter.on(eventName(attemptId), listener);
  return () => {
    emitter.off(eventName(attemptId), listener);
  };
}
