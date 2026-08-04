/**
 * Login and logout. The only unauthenticated, state-changing surface in the API — every
 * other route (from Phase 2 on) sits behind `requireSession`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '@agentmesh/db';
import { createSession, login, revokeSession } from '@agentmesh/db';
import { sessionCookieOptions, SESSION_COOKIE_NAME } from './session-cookie.js';
import { requireSession } from './guard.js';

const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export async function registerAuthRoutes(
  server: FastifyInstance,
  db: Database,
  nodeEnv: string,
): Promise<void> {
  const cookieOptions = sessionCookieOptions(nodeEnv);

  server.post('/auth/login', async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const result = await login(db, body.data.email, body.data.password);
    if (!result.ok) {
      // 403 for a disabled account is not a new leak: reaching this branch already
      // required the correct password, so the caller has already proven the account
      // exists. 401 covers both "no such account" and "wrong password" — see login.ts.
      const status = result.error.kind === 'user_disabled' ? 403 : 401;
      return reply.code(status).send({ error: result.error.kind });
    }

    const token = await createSession(db, result.value.userId);
    reply.setCookie(SESSION_COOKIE_NAME, token, cookieOptions);
    return reply.send({ userId: result.value.userId });
  });

  server.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token !== undefined) {
      await revokeSession(db, token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  server.get('/auth/me', { preHandler: requireSession(db) }, (request, reply) =>
    reply.send({ userId: request.userId }),
  );
}
