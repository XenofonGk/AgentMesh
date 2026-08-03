import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export interface DatabaseHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Cheap liveness probe used by the API health endpoint. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * `connectionString` is passed in rather than read from the environment here — the
 * process owns its config, packages do not reach into `process.env`.
 */
export function createDatabase(connectionString: string): DatabaseHandle {
  const client = postgres(connectionString, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });

  return {
    db,
    async ping(): Promise<boolean> {
      try {
        await db.execute(sql`select 1`);
        return true;
      } catch {
        // The caller only needs liveness; the error may carry connection details.
        return false;
      }
    },
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}
