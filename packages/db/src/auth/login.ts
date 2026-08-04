/**
 * The password login path, against `auth_identities` (provider = 'password').
 *
 * Kept separate from `session.ts`: this module answers "is this the right password for
 * this identity", session.ts answers "is this a valid session". A future OIDC identity
 * provider needs the second and not the first.
 */
import { eq, and } from 'drizzle-orm';
import { type Result, ok, err } from '@agentmesh/core';
import type { Database } from '../client.js';
import { authIdentities, users } from '../schema.js';
import { hashPassword, verifyPassword } from './password.js';

export type LoginFailure = { kind: 'invalid_credentials' } | { kind: 'user_disabled' };

/**
 * Deliberately one failure shape for both "no such email" and "wrong password" —
 * `invalid_credentials` in both cases. Distinguishing them lets an attacker enumerate
 * which emails have accounts; the login form must not do that even though the two cases
 * are trivially distinguishable *inside* this function.
 */
export async function login(
  db: Database,
  email: string,
  password: string,
): Promise<Result<{ userId: string }, LoginFailure>> {
  const normalized = email.trim().toLowerCase();

  const [row] = await db
    .select({
      userId: authIdentities.userId,
      passwordHash: authIdentities.passwordHash,
      status: users.status,
    })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(
      and(
        eq(authIdentities.provider, 'password'),
        eq(authIdentities.externalId, normalized),
      ),
    );

  // Hash a dummy password on the not-found path too, so the response time for "no such
  // account" and "wrong password" is the same shape — a fast rejection on the former
  // would let a login form be used to enumerate registered emails.
  if (row === undefined || row.passwordHash === null) {
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password,
    );
    return err({ kind: 'invalid_credentials' });
  }

  const valid = await verifyPassword(row.passwordHash, password);
  if (!valid) return err({ kind: 'invalid_credentials' });
  if (row.status !== 'active') return err({ kind: 'user_disabled' });

  await db
    .update(authIdentities)
    .set({ lastLoginAt: new Date() })
    .where(
      and(
        eq(authIdentities.provider, 'password'),
        eq(authIdentities.externalId, normalized),
      ),
    );

  return ok({ userId: row.userId });
}

/**
 * Creates a user and a password identity for them in one transaction — a user with no
 * way to log in, or an identity pointing at a user_id that doesn't exist, is a state
 * this schema should never actually produce.
 */
export async function createUserWithPassword(
  db: Database,
  email: string,
  password: string,
): Promise<{ userId: string }> {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({}).returning({ id: users.id });
    await tx.insert(authIdentities).values({
      userId: user!.id,
      provider: 'password',
      externalId: normalized,
      passwordHash,
    });
    return { userId: user!.id };
  });
}
