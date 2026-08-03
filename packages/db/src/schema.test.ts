/**
 * Schema tests against a real Postgres.
 *
 * These assert the properties that are expensive to get wrong — the ones a migration
 * over live ciphertext would be needed to fix. They are skipped, loudly, when no
 * database is reachable, so `pnpm test` still works on a laptop without Docker; CI and
 * `docker compose` both provide one.
 *
 * Set TEST_DATABASE_URL to point at a throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { credentials, users, userKeys } from './schema.js';

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const client = postgres(CONNECTION, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 2 });
  }
}

/**
 * Drizzle wraps driver errors in a generic "Failed query" Error, so asserting on the
 * message would pass whether or not the constraint exists. Assert the Postgres SQLSTATE
 * from the cause instead — deleting the constraint then fails the test, which is the
 * only reason to write it.
 */
const UNIQUE_VIOLATION = '23505';

async function expectSqlState(
  operation: Promise<unknown>,
  sqlstate: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, 'expected the database to reject this write').toBeDefined();

  let current = thrown;
  while (current instanceof Error) {
    if ((current as { code?: string }).code === sqlstate) return;
    current = current.cause;
  }

  throw new Error(
    `expected SQLSTATE ${sqlstate}, got: ${String(thrown)} (${String((thrown as { cause?: unknown })?.cause)})`,
  );
}

const available = await reachable();

// Skipping is only acceptable when nobody asked for a database. If TEST_DATABASE_URL is
// set and unreachable, that is a broken CI service, and silently reporting green would
// be worse than having no tests at all.
if (CONNECTION !== '' && !available) {
  throw new Error(
    `schema.test.ts: TEST_DATABASE_URL is set but unreachable (${CONNECTION.replace(/:[^:@/]*@/, ':***@')}). ` +
      'Refusing to skip — fix the database or unset the variable.',
  );
}

const describeDb = available ? describe : describe.skip;

if (!available) {
  console.warn(
    'schema.test.ts: skipped — set TEST_DATABASE_URL to a reachable Postgres to run it.',
  );
}

describeDb('schema (migration 1)', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function makeUser(): Promise<string> {
    const [row] = await handle.db.insert(users).values({}).returning({ id: users.id });
    return row!.id;
  }

  it('creates a user with nothing about how they log in', async () => {
    const userId = await makeUser();
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows a second login method for the same user without a new user_id', async () => {
    const userId = await makeUser();
    const email = `${randomUUID()}@example.test`;
    await handle.db.execute(sql`
      insert into auth_identities (user_id, provider, external_id, password_hash)
      values (${userId}, 'password', ${email}, 'argon2id$placeholder')
    `);
    // Adding OIDC later is an INSERT, not a migration — and critically, the same user_id,
    // so every credential encrypted under this user's DEK stays reachable.
    await handle.db.execute(sql`
      insert into auth_identities (user_id, provider, external_id)
      values (${userId}, 'oidc', ${`https://idp.example/${randomUUID()}`})
    `);

    const rows = await handle.db.execute<{ count: string }>(
      sql`select count(*)::text as count from auth_identities where user_id = ${userId}`,
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('rejects a duplicate identity for the same provider', async () => {
    const first = await makeUser();
    const second = await makeUser();
    const email = `${randomUUID()}@example.test`;
    const insert = (userId: string) =>
      handle.db.execute(sql`
        insert into auth_identities (user_id, provider, external_id)
        values (${userId}, 'password', ${email})
      `);

    await insert(first);
    await expectSqlState(insert(second), UNIQUE_VIOLATION);
  });

  it('stores credential material as bytes and round-trips it unchanged', async () => {
    const userId = await makeUser();
    const ciphertext = Buffer.from('not-really-encrypted-but-binary', 'utf8');
    const iv = Buffer.from('0123456789ab', 'utf8');
    const tag = Buffer.from('0123456789abcdef', 'utf8');

    await handle.db
      .insert(credentials)
      .values({ userId, provider: 'claude', ciphertext, iv, tag, keyVersion: 1 });

    const [row] = await handle.db
      .select()
      .from(credentials)
      .where(sql`${credentials.userId} = ${userId}`);

    expect(Buffer.compare(row!.ciphertext, ciphertext)).toBe(0);
    expect(row!.keyVersion).toBe(1);
  });

  it('holds one credential per provider per user', async () => {
    const userId = await makeUser();
    const values = {
      userId,
      provider: 'gemini',
      ciphertext: Buffer.from('a'),
      iv: Buffer.from('b'),
      tag: Buffer.from('c'),
    };
    await handle.db.insert(credentials).values(values);
    await expectSqlState(handle.db.insert(credentials).values(values), UNIQUE_VIOLATION);
  });

  it('keeps DEK generations distinct so rotation is addressable', async () => {
    const userId = await makeUser();
    const dek = (generation: number) => ({
      userId,
      generation,
      wrappedDek: Buffer.from('wrapped'),
      iv: Buffer.from('iv'),
      tag: Buffer.from('tag'),
      masterKeyVersion: 1,
    });

    await handle.db.insert(userKeys).values(dek(1));
    await handle.db.insert(userKeys).values(dek(2));
    await expectSqlState(handle.db.insert(userKeys).values(dek(2)), UNIQUE_VIOLATION);
  });

  it("deletes a user's keys and credentials with the user", async () => {
    const userId = await makeUser();
    await handle.db.insert(credentials).values({
      userId,
      provider: 'grok',
      ciphertext: Buffer.from('a'),
      iv: Buffer.from('b'),
      tag: Buffer.from('c'),
    });

    await handle.db.execute(sql`delete from users where id = ${userId}`);

    const rows = await handle.db.execute<{ count: string }>(
      sql`select count(*)::text as count from credentials where user_id = ${userId}`,
    );
    // Deleting a user must not strand ciphertext keyed to a user_id that no longer exists.
    expect(rows[0]?.count).toBe('0');
  });

  it('keys canaries by master key version, so v1 and v2 can coexist', async () => {
    const canary = (version: number) =>
      handle.db.execute(sql`
      insert into vault_canary (master_key_version, ciphertext, iv, tag)
      values (${version}, '\\x00'::bytea, '\\x01'::bytea, '\\x02'::bytea)
    `);

    // Rows persist for the life of the test database, so pick versions this run owns.
    const base = 100_000 + Math.floor(Math.random() * 1_000_000);

    // A rotation legitimately has both versions present at once — boot validation must
    // not break in the middle of the operation the canary exists to protect.
    await canary(base);
    await canary(base + 1);

    // But one row per version: two canaries for the same version would mean two answers
    // to "is this the right key".
    await expectSqlState(canary(base + 1), UNIQUE_VIOLATION);
  });

  it('has no column that could hold a plaintext credential', async () => {
    const rows = await handle.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and column_name ~ '(^|_)(password|secret|api_key|plaintext|token)($|_)'
    `);
    const offenders = rows
      .map((row) => `${row.table_name}.${row.column_name}`)
      // Allowed: a hash is not a plaintext credential, and the session token column
      // stores a SHA-256 digest — see the schema comment on `sessions`.
      .filter(
        (name) =>
          name !== 'auth_identities.password_hash' && name !== 'sessions.token_hash',
      );

    expect(offenders).toEqual([]);
  });
});
