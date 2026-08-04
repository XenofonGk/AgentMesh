/**
 * Authenticated credential management — the first routes that sit behind
 * `requireSession`, and the first HTTP surface onto the `Vault`.
 *
 * The secret value itself only ever appears in the PUT request body. Every response —
 * the PUT confirmation, the GET list, anything — is built from `CredentialSummary` or
 * an id, never from the plaintext or the ciphertext. See `Vault.listCredentials`'s own
 * comment for why the column list there is explicit rather than `select()`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Vault } from '@agentmesh/db';
import { requireSession } from '../auth/guard.js';
import type { Database } from '@agentmesh/db';

/**
 * Lowercase slug, matching the free-text `provider` column (schema.ts: intentionally
 * not an enum, so a new adapter is never a migration). Constrained here anyway, because
 * this value flows into the AAD that authenticates the ciphertext — accepting arbitrary
 * bytes as a "provider" would just be a wider door onto the same string.
 */
const ProviderParam = z.object({
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase letters, digits, and hyphens'),
});

const PutCredentialBody = z.object({
  /** The raw provider API key. Never logged — see redact() and the route handler below. */
  apiKey: z.string().min(1).max(8192),
});

export async function registerCredentialRoutes(
  server: FastifyInstance,
  db: Database,
  vault: Vault,
): Promise<void> {
  const guard = { preHandler: requireSession(db) };

  server.get('/credentials', guard, async (request, reply) => {
    const list = await vault.listCredentials(request.userId!);
    return reply.send({ credentials: list });
  });

  server.put('/credentials/:provider', guard, async (request, reply) => {
    const params = ProviderParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_provider' });
    }

    const body = PutCredentialBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const plaintext = Buffer.from(body.data.apiKey, 'utf8');
    const result = await vault.putCredential(
      request.userId!,
      params.data.provider,
      plaintext,
    );
    if (!result.ok) {
      request.log.error({ err: result.error }, 'failed to store credential');
      return reply.code(500).send({ error: 'storage_failed' });
    }

    return reply.send({
      provider: params.data.provider,
      keyVersion: result.value.keyVersion,
    });
  });

  server.delete('/credentials/:provider', guard, async (request, reply) => {
    const params = ProviderParam.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_provider' });
    }

    const result = await vault.deleteCredential(request.userId!, params.data.provider);
    if (!result.ok) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return reply.code(204).send();
  });
}
