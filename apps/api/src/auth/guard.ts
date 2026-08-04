/**
 * The session-auth guard every protected route uses. First consumer is
 * `apps/api/src/credentials/routes.ts`; written alongside login/logout, ahead of that
 * consumer, so the shape of "how a route asserts a caller is signed in" was decided
 * once rather than improvised per route.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '@agentmesh/db';
import { validateSession } from '@agentmesh/db';
import { SESSION_COOKIE_NAME } from './session-cookie.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireSession` once the cookie has been validated against the DB. */
    userId?: string;
  }
}

/**
 * Fails the request with 401 if there is no valid session, and otherwise sets
 * `request.userId`. Registered per-route (`{ preHandler: requireSession(db) }`) rather
 * than globally, so `/health` and `/auth/login` itself are never accidentally gated.
 */
export function requireSession(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = token === undefined ? null : await validateSession(db, token);

    if (session === null) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }

    request.userId = session.userId;
  };
}
