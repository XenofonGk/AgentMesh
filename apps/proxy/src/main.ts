/**
 * Process entry point. Deliberately separate from `index.ts`, which is the library
 * barrel `apps/proxy/src/index.test.ts` and other packages import from — this file has
 * side effects (it starts a server and calls `process.exit`), and a module tests import
 * for its exports must never have those.
 *
 * Runs its own `verifyOrInitialize()` against the same `VAULT_MASTER_KEY` the API uses.
 * The API is what actually runs migrations and owns first-boot canary initialization;
 * this process assumes that has already happened and simply proves *its* key matches —
 * a wrong key here must refuse to start for exactly the reason it must in the API.
 */
import { createDatabase, loadMasterKey, Vault, wipe } from '@agentmesh/db';
import { loadConfig } from './config.js';
import { buildProxyServer } from './server.js';
import { PROXY_BIND_HOST } from './constants.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const database = createDatabase(config.DATABASE_URL);

  const masterKey = loadMasterKey();
  const vault = new Vault(database.db, masterKey);
  try {
    await vault.verifyOrInitialize();
  } catch (error) {
    await database.close();
    throw error;
  }

  const { server } = await buildProxyServer({
    vault,
    db: database.db,
    logLevel: config.LOG_LEVEL,
  });

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutting down');
    await server.close();
    await database.close();
    wipe(masterKey.bytes);
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // PROXY_BIND_HOST is a constant, never config.PROXY_HOST — see constants.ts. Reaching
  // the public internet requires both this AND a host-published port in compose.yaml;
  // there is deliberately no way to configure the latter into existing either.
  await server.listen({ host: PROXY_BIND_HOST, port: config.PROXY_PORT });
}

main().catch((error: unknown) => {
  console.error('Proxy failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
