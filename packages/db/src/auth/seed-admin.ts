/**
 * Seeds a single admin account on first boot. This is the *only* way a user enters the
 * system in Phase 1 — there is no signup flow yet, deliberately (D5: trusted operator,
 * not open registration).
 *
 * Follows the same shape as `loadMasterKey`: required env vars, fail fast with a
 * specific message, never echo the secret. That consistency is intentional — an
 * operator who has already read one of these error messages should recognize the next.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { authIdentities } from '../schema.js';
import { createUserWithPassword } from './login.js';

const MIN_PASSWORD_LENGTH = 12;

/**
 * The literal value shipped in `.env.example`, same reasoning as
 * `master-key.ts`'s `PLACEHOLDER_MASTER_KEY`: people copy the file and never change it,
 * and this one is public in the repository. Without this check, an unchanged
 * `.env.example` would produce a *working* admin login with a password anyone can read
 * on GitHub — worse than the vault key case, because this credential is used directly
 * against a login form rather than sitting behind another layer of encryption.
 */
export const PLACEHOLDER_ADMIN_PASSWORD = 'REPLACE_ME_RUN_openssl_rand_base64_18';

export class AdminSeedError extends Error {
  override readonly name = 'AdminSeedError';
}

function fail(message: string): never {
  throw new AdminSeedError(message);
}

export interface SeedAdminOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Idempotent: if a password identity already exists for `ADMIN_EMAIL`, this is a no-op.
 * That makes it safe to call on every boot rather than gating it behind a one-shot
 * migration or a manual step — an operator restarting the stack must never get a second
 * admin account or an error because "it already ran".
 */
export async function seedAdmin(
  db: Database,
  options: SeedAdminOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const email = env['ADMIN_EMAIL']?.trim().toLowerCase() ?? '';
  const password = env['ADMIN_PASSWORD'] ?? '';

  if (email === '' && password === '') {
    // No admin configured at all. Valid for a from-source dev loop that seeds a user a
    // different way; the API's own boot path (index.ts) treats this as fatal instead —
    // see the comment there.
    return;
  }

  if (email === '') fail('ADMIN_PASSWORD is set but ADMIN_EMAIL is not. Set both.');
  if (password === '') fail('ADMIN_EMAIL is set but ADMIN_PASSWORD is not. Set both.');
  if (password === PLACEHOLDER_ADMIN_PASSWORD) {
    fail(
      'ADMIN_PASSWORD is still the placeholder value from .env.example. That value is ' +
        'public in the repository — generate a real one: openssl rand -base64 18',
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const [existing] = await db
    .select({ id: authIdentities.id })
    .from(authIdentities)
    .where(
      and(eq(authIdentities.provider, 'password'), eq(authIdentities.externalId, email)),
    );

  if (existing !== undefined) return;

  try {
    await createUserWithPassword(db, email, password);
  } catch (error) {
    // Two API processes booting at the same instant both pass the check above and both
    // try to insert. The unique index on (provider, external_id) is the real guard;
    // losing this race is exactly as idempotent as winning it, so swallow only that one
    // failure shape and let every other error surface as the boot failure it is.
    if (!isUniqueViolation(error)) throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
