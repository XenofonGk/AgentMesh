/**
 * Drizzle schema — migration 1.
 *
 * The organizing rule: **does ciphertext depend on this shape?** Anything a stored
 * ciphertext is keyed to can never be reshaped without a migration over live encrypted
 * data, so it has to be right now. Anything else can be dropped and recreated for free,
 * and should not be over-designed.
 *
 *   Permanent, get it right now   → users.id, user_keys, credentials
 *   Cheap to change later         → sessions, auth_identities rows
 *
 * Identity and login method are separated for the same reason. `users` says nothing
 * about how someone authenticates, so adding OIDC later is an INSERT into
 * `auth_identities`, not a migration — and never a duplicate account with a new
 * `user_id` that existing ciphertext is no longer reachable from.
 */
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Raw binary. Ciphertext, IVs, and auth tags are bytes, not text — storing them base64
 * in a text column invites someone logging the column "because it's just a string".
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'disabled']);

/**
 * Opaque identity. No email, no password, no provider — deliberately nothing about how
 * this person logs in. `id` is referenced by every wrapped DEK and every credential, so
 * it is the one value in the schema that can never change.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  status: userStatus('status').notNull().default('active'),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
});

/**
 * How a user proves they are that user. One row per login method, so a user can hold a
 * password today and an OIDC identity tomorrow without either the row or the user_id
 * changing.
 *
 * `provider` is free text rather than an enum: adding 'github' should be a row, and an
 * enum would make it a migration — which is the thing this table exists to avoid.
 * `external_id` is the identifier *within* that provider: an email for 'password', the
 * issuer's subject claim for 'oidc'.
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    /** Argon2id. Null for every provider that is not 'password'. */
    passwordHash: text('password_hash'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    lastLoginAt: timestamptz('last_login_at'),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_external_id_idx').on(
      table.provider,
      table.externalId,
    ),
    index('auth_identities_user_id_idx').on(table.userId),
  ],
);

/**
 * Server-side sessions. Revocability beats statelessness here — a compromised session
 * or a removed user must stop working immediately, and a JWT cannot be un-issued.
 *
 * `id` is the SHA-256 of the session token, never the token itself. A session cookie is
 * a bearer credential: invariant 1 applies to it exactly as it does to a provider key,
 * so a database dump must not be a set of working logins.
 *
 * Deliberately thin — no device metadata, no rotation chain. This is the table that is
 * cheap to drop and recreate, so it should not carry decisions it does not need yet.
 */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: bytea('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Per-user data-encryption keys, wrapped by the master key. The DEK plaintext exists
 * only in proxy memory during one request (invariant 4) — what lives here is ciphertext.
 *
 * Two independent version numbers, because there are two independent rotations:
 *
 *   master_key_version  which master key wrapped this DEK. Rotating the master key
 *                       re-wraps DEKs — it does not touch a single credential row.
 *   generation          which DEK this is for the user. Rotating a DEK *does* require
 *                       re-encrypting that user's credentials, so it is versioned
 *                       separately and referenced by credentials.key_version.
 *
 * Old rows are retired rather than deleted: `retired_at` set, ciphertext kept, so an
 * interrupted rotation is recoverable instead of being data loss.
 */
export const userKeys = pgTable(
  'user_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull().default(1),
    wrappedDek: bytea('wrapped_dek').notNull(),
    iv: bytea('iv').notNull(),
    tag: bytea('tag').notNull(),
    masterKeyVersion: integer('master_key_version').notNull().default(1),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    retiredAt: timestamptz('retired_at'),
  },
  (table) => [
    uniqueIndex('user_keys_user_id_generation_idx').on(table.userId, table.generation),
  ],
);

/**
 * Encrypted provider credentials. AES-256-GCM under the user's DEK.
 *
 * `key_version` is the `user_keys.generation` that encrypted this row — without it,
 * rotation cannot tell which rows are still readable, and that is a column you cannot
 * add later without a migration over live ciphertext.
 *
 * There is no plaintext column here and never will be (invariant 1). `last_used_at`
 * records *that* a credential was used, never the value (§4, audit).
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'claude' | 'gemini' | 'deepseek' | 'grok' | … — text, so a new adapter is not a migration. */
    provider: text('provider').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    tag: bytea('tag').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (table) => [
    uniqueIndex('credentials_user_id_provider_idx').on(table.userId, table.provider),
    index('credentials_user_id_idx').on(table.userId),
  ],
);

/**
 * One encrypted canary **per master key version**, written when that version is first
 * used and decrypted on boot.
 *
 * This is what distinguishes "no master key configured" from "the wrong master key".
 * Without it, booting with a wrong key looks exactly like booting with an empty vault —
 * and the user helpfully re-enters their API keys, encrypting them under the new key,
 * on top of ciphertext they can no longer read. The canary makes that failure loud:
 * a wrong key refuses to start.
 *
 * Keyed by version rather than being a single row, because during a rotation v1 and v2
 * legitimately coexist: DEKs are re-wrapped one at a time, and until the last one moves,
 * both keys must validate. A single-row canary would make boot validation fail in the
 * middle of exactly the operation it is meant to protect.
 */
export const vaultCanary = pgTable('vault_canary', {
  masterKeyVersion: integer('master_key_version').primaryKey(),
  ciphertext: bytea('ciphertext').notNull(),
  iv: bytea('iv').notNull(),
  tag: bytea('tag').notNull(),
  createdAt: timestamptz('created_at')
    .notNull()
    .default(sql`now()`),
  retiredAt: timestamptz('retired_at'),
});
