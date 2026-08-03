import { createDatabase, loadMasterKey, runMigrations, Vault, wipe } from '@agentmesh/db';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Before the server accepts a single request. A schema mismatch should be a failed
  // start, not a stream of 500s from handlers querying tables that do not exist.
  await runMigrations(config.DATABASE_URL);

  const database = createDatabase(config.DATABASE_URL);

  // Then prove the master key is the right one. A wrong key must stop the process here:
  // serving with an unreadable vault means a user is shown an empty credential list and
  // re-enters their API keys on top of ciphertext nobody can recover.
  const masterKey = loadMasterKey();
  try {
    await new Vault(database.db, masterKey).verifyOrInitialize();
  } catch (error) {
    await database.close();
    throw error;
  }

  const { server } = await buildServer({ config, database });

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

  await server.listen({ host: config.API_HOST, port: config.API_PORT });
}

main().catch((error: unknown) => {
  // Startup failure: log and exit non-zero so the container restarts or fails loudly.
  // `error.message` only — a stack here could carry a connection string.
  console.error('API failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
