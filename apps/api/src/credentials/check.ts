/**
 * Shared by both `/runs` and `/chats`: reject up front, before any container spins up,
 * rather than let an attempt reach the adapter/SDK and die there with whatever opaque
 * error the upstream client library surfaces for "no credential" (observed for Claude:
 * literally the string "unknown").
 *
 * Goes through `Vault.listCredentials`, not a direct query — `packages/core/src/
 * provider.ts`'s whole point is that there is exactly one place that reads credential
 * rows, and `provider.test.ts` fails CI if a second one shows up.
 */
import type { Vault } from '@agentmesh/db';

/** Providers the vault never holds a secret for — see `apps/proxy/src/providers.ts`'s
 *  `secretRequired: false` on the ollama route, which is the same fact this mirrors. */
export const CREDENTIAL_FREE_PROVIDERS = new Set(['ollama']);

/**
 * Returns the requested providers that need a credential but don't have one stored —
 * empty if the request can proceed. `vault` is optional only because a handful of
 * tests build a server with an orchestrator but no vault; in production `index.ts`
 * always wires both together, and the credential-free providers (today: `ollama`)
 * never reach the `undefined` branch at all, since they're filtered out first.
 */
export async function missingCredentials(
  vault: Vault | undefined,
  userId: string,
  providers: readonly string[],
): Promise<string[]> {
  const needCredential = providers.filter((p) => !CREDENTIAL_FREE_PROVIDERS.has(p));
  if (needCredential.length === 0) return [];
  if (!vault) return needCredential;

  const configured = new Set(
    (await vault.listCredentials(userId)).map((c) => c.provider),
  );
  return needCredential.filter((p) => !configured.has(p));
}
