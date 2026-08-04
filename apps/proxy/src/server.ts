/**
 * The forwarding path: everything a runner's request goes through between "I am run R"
 * and a credentialed request landing at a provider.
 *
 * Every step here exists to close one specific hole:
 *
 *   1. Resolve (provider, path) against the pinned
 *      route table — never the request's Host/URL    (the SSRF guard — see providers.ts;
 *                                                      also decides which header the run
 *                                                      token below travels in)
 *   2. Resolve the run token → grant, read out of
 *      route.authHeader                               (never trust a provider/user the
 *      (packages/db/src/run-grants.ts)                runner claims directly — see the
 *                                                      module doc on headers.ts for why
 *                                                      it's this header, not a bespoke one)
 *   3. Check the grant permits this provider         (a Claude run can't spend Gemini)
 *   4. Filter inbound headers to an allowlist         (the runner cannot spoof or shadow
 *                                                      the header we're about to inject)
 *   5. Inject the vault-held secret, forward, relay
 *      the response back byte-for-byte                (no SSE parsing here — that is the
 *                                                      adapter's job, not the proxy's)
 */
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database, Vault } from '@agentmesh/db';
import { grantPermits, resolveRunToken } from '@agentmesh/db';
import { redact } from '@agentmesh/core';
import {
  DEFAULT_PROVIDER_ROUTES,
  resolveProviderRoute,
  type ProviderRoute,
} from './providers.js';
import { filterInboundHeaders } from './headers.js';
import { PROXY_BIND_HOST } from './constants.js';

export interface BuildProxyOptions {
  vault: Vault;
  /** Where run grants are resolved from — see packages/db/src/run-grants.ts. */
  db: Database;
  /** Injectable so tests can point 'claude' at a fake upstream instead of the real API. */
  providerRoutes?: readonly ProviderRoute[];
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface ProxyApp {
  server: FastifyInstance;
}

/**
 * Only present so callers who never touch a request body get a real value; `undefined`
 * is fine to hand to `fetch`, this is about avoiding an accidental `Buffer.from(undefined)`.
 */
const EMPTY_BODY = Buffer.alloc(0);

export async function buildProxyServer({
  vault,
  db,
  providerRoutes = DEFAULT_PROVIDER_ROUTES,
  logLevel = 'info',
}: BuildProxyOptions): Promise<ProxyApp> {
  const server = Fastify({
    logger: {
      level: logLevel,
      // Same reasoning as apps/api: every log payload is redacted. A run token or a
      // stray Authorization header ending up in a log line is exactly invariant 1.
      serializers: {
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url };
        },
      },
    },
  });

  // The proxy relays bytes; it does not parse or validate the body. Fastify's built-in
  // default parser for `application/json` re-serializes the body, which risks subtle
  // differences (number precision, key order) from what the runner actually sent — and
  // it takes priority over a `'*'` parser for any content type it already owns, so the
  // defaults have to go before the wildcard buffer parser actually applies to JSON.
  server.removeAllContentTypeParsers();
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  /** Liveness only — used by Compose's healthcheck. Never touches the database. */
  server.get('/health', () => ({ status: 'ok' as const }));

  server.all('/providers/:provider/*', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const wildcard = (request.params as { '*': string })['*'];
    const upstreamPath = `/${wildcard}`;

    // Resolved before the token: which header the run token travels in depends on the
    // provider (route.authHeader — the same header a real credential would occupy,
    // since that's the only header a provider's own SDK/CLI knows how to send one in).
    // Same failure shape for "unknown provider" and "unlisted path" (see providers.ts):
    // a probe for an unlisted endpoint should not distinguish the two.
    const route = resolveProviderRoute(provider, upstreamPath, providerRoutes);
    if (route === null) {
      return reply.code(404).send({ error: 'unknown_route' });
    }

    const token = request.headers[route.authHeader];
    if (typeof token !== 'string' || token === '') {
      return reply.code(401).send({ error: 'missing_run_token' });
    }

    const grant = await resolveRunToken(db, token);
    if (grant === null) {
      return reply.code(401).send({ error: 'invalid_run_token' });
    }

    if (!grantPermits(grant, provider)) {
      return reply.code(403).send({ error: 'provider_not_permitted' });
    }

    const outboundHeaders = filterInboundHeaders(request.headers);
    const body = Buffer.isBuffer(request.body) ? request.body : EMPTY_BODY;

    const result = await vault.useCredential(
      grant.userId,
      route.provider,
      async (secret) => {
        // The one unavoidable exception to "plaintext is always a Buffer, never a
        // string" (crypto.ts, SECURITY.md → Zeroization): fetch's Headers only accept
        // strings. This copy is scoped to this callback and never returned, logged, or
        // stored — best-effort, same caveat as everywhere else a secret meets a string.
        outboundHeaders[route.authHeader] = secret.toString('utf8');

        const init: RequestInit = { method: request.method, headers: outboundHeaders };
        if (body.length > 0) init.body = body;
        return fetch(route.origin + upstreamPath, init);
      },
    );

    if (!result.ok) {
      request.log.warn({ err: redact(result.error) }, 'credential unavailable for run');
      // 424: the request depends on configuration (a stored credential) that isn't
      // there or isn't usable — not the runner's fault, not this proxy's fault, and
      // not something retrying without the user fixing their vault entry will resolve.
      return reply.code(424).send({ error: 'credential_unavailable' });
    }

    const upstream = result.value;
    reply.code(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType !== null) reply.header('content-type', contentType);

    if (upstream.body === null) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body));
  });

  return { server };
}

export { PROXY_BIND_HOST };
