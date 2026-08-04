import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { redact } from '@agentmesh/core';
import { createDatabase, type DatabaseHandle, type Vault } from '@agentmesh/db';
import type { Config } from './config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerCredentialRoutes } from './credentials/routes.js';

export interface BuildOptions {
  config: Config;
  /** Injectable so tests can run without a live Postgres. */
  database?: DatabaseHandle;
  /**
   * Optional so `server.test.ts`'s liveness/readiness checks don't need a real vault.
   * Required in practice: omitting it just means the credential routes never register,
   * which routes.test.ts (real Postgres, real Vault) exercises to catch.
   */
  vault?: Vault;
}

export interface App {
  server: FastifyInstance;
  database: DatabaseHandle;
}

export async function buildServer({
  config,
  database,
  vault,
}: BuildOptions): Promise<App> {
  const db = database ?? createDatabase(config.DATABASE_URL);

  const server = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Every log payload passes through redact() before serialization — invariant 1.
      // Errors are the highest-risk path: connection strings and upstream responses
      // routinely end up in a message or a stack.
      serializers: {
        err(error: FastifyError) {
          const safe = redact({
            message: error.message,
            stack: error.stack ?? '',
          }) as { message: string; stack: string };
          return { type: error.name, message: safe.message, stack: safe.stack };
        },
      },
    },
  });

  await server.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  // No `secret` option: this project signs nothing into the cookie value. The cookie
  // carries an opaque session token; the token is what's validated against the
  // `sessions` table, so a forged-but-unsigned cookie fails at that lookup regardless.
  await server.register(cookie);

  await registerAuthRoutes(server, db.db, config.NODE_ENV);
  if (vault !== undefined) {
    await registerCredentialRoutes(server, db.db, vault);
  }

  /** Liveness: is the process up? Never touches the database. */
  server.get('/health', () => ({ status: 'ok' as const }));

  /** Readiness: can we serve traffic? Used by Compose's healthcheck. */
  server.get('/readyz', async (_request, reply) => {
    const databaseUp = await db.ping();
    if (!databaseUp) {
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
    return reply.send({ status: 'ok', database: 'up' });
  });

  return { server, database: db };
}
