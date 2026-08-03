import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Generated SQL lives next to the built package, so it ships in the runtime image
 * (`files` in package.json) rather than only existing in a dev checkout.
 */
const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '..', 'migrations');

/**
 * Applies any pending migrations, then closes its own connection.
 *
 * Runs on API startup rather than as a separate Compose service: this is a
 * single-instance self-hosted tool, so the coordination problem that makes
 * migrate-on-boot a bad idea at scale does not exist here, and the alternative is an
 * operator who forgets the step and meets a confusing "relation does not exist".
 *
 * A dedicated single-connection client is used so a failed migration cannot leave a
 * poisoned connection in the application pool.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}
