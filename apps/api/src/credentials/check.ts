/**
 * Shared by both `/runs` and `/chats`: reject up front, before any container spins up,
 * rather than let an attempt reach the adapter/SDK and die there with whatever opaque
 * error the upstream client library surfaces for "no credential" (observed for Claude:
 * literally the string "unknown").
 */
import { eq } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import { schema } from '@agentmesh/db';

const { credentials } = schema;

/** Providers the vault never holds a secret for — see `apps/proxy/src/providers.ts`'s
 *  `secretRequired: false` on the ollama route, which is the same fact this mirrors. */
export const CREDENTIAL_FREE_PROVIDERS = new Set(['ollama']);

/** Returns the requested providers that need a credential but don't have one stored —
 *  empty if the request can proceed. */
export async function missingCredentials(
  db: Database,
  userId: string,
  providers: readonly string[],
): Promise<string[]> {
  const needCredential = providers.filter((p) => !CREDENTIAL_FREE_PROVIDERS.has(p));
  if (needCredential.length === 0) return [];

  const rows = await db
    .select({ provider: credentials.provider })
    .from(credentials)
    .where(eq(credentials.userId, userId));
  const configured = new Set(rows.map((r) => r.provider));
  return needCredential.filter((p) => !configured.has(p));
}
