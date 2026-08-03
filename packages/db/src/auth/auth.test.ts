/**
 * Login, sessions, and admin seeding against a real Postgres. Skipped without
 * TEST_DATABASE_URL; refuses to skip when one is configured but unreachable (see
 * schema.test.ts for the reasoning).
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../client.js';
import { runMigrations } from '../migrate.js';
import { authIdentities, sessions, users } from '../schema.js';
import { eq } from 'drizzle-orm';
import { createUserWithPassword, login } from './login.js';
import {
  createSession,
  revokeAllSessions,
  revokeSession,
  validateSession,
} from './session.js';
import { AdminSeedError, PLACEHOLDER_ADMIN_PASSWORD, seedAdmin } from './seed-admin.js';

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

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'auth.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;
const uniqueEmail = () => `${randomUUID()}@example.test`;

describeDb('login', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('succeeds with the right password', async () => {
    const email = uniqueEmail();
    await createUserWithPassword(handle.db, email, 'a genuinely long passphrase');
    const result = await login(handle.db, email, 'a genuinely long passphrase');
    expect(result.ok).toBe(true);
  });

  it('is case-insensitive and trims the email, both at creation and login', async () => {
    const email = uniqueEmail();
    await createUserWithPassword(handle.db, email, 'a genuinely long passphrase');
    const result = await login(
      handle.db,
      `  ${email.toUpperCase()}  `,
      'a genuinely long passphrase',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const email = uniqueEmail();
    await createUserWithPassword(handle.db, email, 'a genuinely long passphrase');
    const result = await login(handle.db, email, 'a completely different phrase');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('invalid_credentials');
  });

  it('rejects an email with no account, with the same failure kind as a wrong password', async () => {
    const result = await login(handle.db, uniqueEmail(), 'whatever password');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('invalid_credentials');
  });

  it('rejects a disabled user even with the correct password', async () => {
    const email = uniqueEmail();
    const { userId } = await createUserWithPassword(
      handle.db,
      email,
      'a genuinely long passphrase',
    );
    await handle.db.update(users).set({ status: 'disabled' }).where(eq(users.id, userId));

    const result = await login(handle.db, email, 'a genuinely long passphrase');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('user_disabled');
  });

  it('takes roughly the same time whether the email exists or not', async () => {
    const email = uniqueEmail();
    await createUserWithPassword(handle.db, email, 'a genuinely long passphrase');

    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    };

    const existingEmailTime = await time(() => login(handle.db, email, 'wrong password'));
    const missingEmailTime = await time(() =>
      login(handle.db, uniqueEmail(), 'wrong password'),
    );

    // Not a precise timing-attack test — CI jitter makes that unreliable — but the two
    // paths should be within the same order of magnitude, which a short-circuit on
    // "email not found" would violate outright (sub-millisecond vs ~50ms+ for a hash).
    const ratio =
      Math.max(existingEmailTime, missingEmailTime) /
      Math.min(existingEmailTime, missingEmailTime);
    expect(ratio).toBeLessThan(5);
  });

  it('records lastLoginAt on success and leaves it null before any login', async () => {
    const email = uniqueEmail();
    await createUserWithPassword(handle.db, email, 'a genuinely long passphrase');

    const [before] = await handle.db
      .select({ lastLoginAt: authIdentities.lastLoginAt })
      .from(authIdentities)
      .where(eq(authIdentities.externalId, email));
    expect(before?.lastLoginAt).toBeNull();

    await login(handle.db, email, 'a genuinely long passphrase');

    const [after] = await handle.db
      .select({ lastLoginAt: authIdentities.lastLoginAt })
      .from(authIdentities)
      .where(eq(authIdentities.externalId, email));
    expect(after?.lastLoginAt).toBeInstanceOf(Date);
  });
});

describeDb('sessions', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('validates a session it created', async () => {
    const { userId } = await createUserWithPassword(
      handle.db,
      uniqueEmail(),
      'passphrase enough',
    );
    const token = await createSession(handle.db, userId);
    const session = await validateSession(handle.db, token);
    expect(session?.userId).toBe(userId);
  });

  it('rejects a token it never issued', async () => {
    expect(await validateSession(handle.db, 'not-a-real-token')).toBeNull();
  });

  it('stores no raw token in the database', async () => {
    const { userId } = await createUserWithPassword(
      handle.db,
      uniqueEmail(),
      'passphrase enough',
    );
    const token = await createSession(handle.db, userId);

    const rows = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash.toString('hex')).not.toContain(token);
  });

  it('rejects a session after it is revoked', async () => {
    const { userId } = await createUserWithPassword(
      handle.db,
      uniqueEmail(),
      'passphrase enough',
    );
    const token = await createSession(handle.db, userId);
    await revokeSession(handle.db, token);
    expect(await validateSession(handle.db, token)).toBeNull();
  });

  it('revokeAllSessions invalidates every session for a user, not other users', async () => {
    const { userId: userA } = await createUserWithPassword(
      handle.db,
      uniqueEmail(),
      'passphrase enough',
    );
    const { userId: userB } = await createUserWithPassword(
      handle.db,
      uniqueEmail(),
      'passphrase enough',
    );
    const tokenA1 = await createSession(handle.db, userA);
    const tokenA2 = await createSession(handle.db, userA);
    const tokenB = await createSession(handle.db, userB);

    await revokeAllSessions(handle.db, userA);

    expect(await validateSession(handle.db, tokenA1)).toBeNull();
    expect(await validateSession(handle.db, tokenA2)).toBeNull();
    expect(await validateSession(handle.db, tokenB)).not.toBeNull();
  });
});

describeDb('seedAdmin', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('creates an admin from ADMIN_EMAIL / ADMIN_PASSWORD', async () => {
    const email = uniqueEmail();
    await seedAdmin(handle.db, {
      env: { ADMIN_EMAIL: email, ADMIN_PASSWORD: 'a sufficiently long admin password' },
    });
    const result = await login(handle.db, email, 'a sufficiently long admin password');
    expect(result.ok).toBe(true);
  });

  it('is idempotent — seeding twice does not error or duplicate', async () => {
    const email = uniqueEmail();
    const env = {
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: 'a sufficiently long admin password',
    };
    await seedAdmin(handle.db, { env });
    await seedAdmin(handle.db, { env });

    const rows = await handle.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.externalId, email));
    expect(rows).toHaveLength(1);
  });

  it('does nothing when neither variable is set', async () => {
    await expect(seedAdmin(handle.db, { env: {} })).resolves.toBeUndefined();
  });

  it('refuses ADMIN_EMAIL without ADMIN_PASSWORD', async () => {
    await expect(
      seedAdmin(handle.db, { env: { ADMIN_EMAIL: uniqueEmail() } }),
    ).rejects.toThrow(AdminSeedError);
  });

  it('refuses ADMIN_PASSWORD without ADMIN_EMAIL', async () => {
    await expect(
      seedAdmin(handle.db, {
        env: { ADMIN_PASSWORD: 'a sufficiently long admin password' },
      }),
    ).rejects.toThrow(AdminSeedError);
  });

  it('refuses a short admin password', async () => {
    await expect(
      seedAdmin(handle.db, {
        env: { ADMIN_EMAIL: uniqueEmail(), ADMIN_PASSWORD: 'short' },
      }),
    ).rejects.toThrow(/at least/);
  });

  it('refuses the placeholder password from .env.example', async () => {
    await expect(
      seedAdmin(handle.db, {
        env: { ADMIN_EMAIL: uniqueEmail(), ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD },
      }),
    ).rejects.toThrow(/placeholder/i);
  });

  it('never echoes the admin password in a validation error', async () => {
    // Deliberately below MIN_PASSWORD_LENGTH, so this exercises the failure path.
    const secret = 'short9';
    await expect(
      seedAdmin(handle.db, {
        env: { ADMIN_EMAIL: uniqueEmail(), ADMIN_PASSWORD: secret },
      }),
    ).rejects.toThrow(/at least/);

    try {
      await seedAdmin(handle.db, {
        env: { ADMIN_EMAIL: uniqueEmail(), ADMIN_PASSWORD: secret },
      });
      expect.unreachable('expected seedAdmin to throw');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
