/**
 * Server-side sessions, against the `sessions` table (schema.ts). Revocable — the whole
 * reason this project uses sessions instead of JWTs (see SECURITY.md).
 *
 * The token the browser holds and the row in the database are deliberately different
 * values: `sessions.token_hash` stores SHA-256(token), never the token. A session cookie
 * is a bearer credential — invariant 1 applies to it exactly as to a provider key — so a
 * database dump must not be a set of working logins.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { sessions, users } from '../schema.js';

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  userId: string;
  expiresAt: Date;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Creates a session and returns the raw token — the only time it ever exists in full. */
export async function createSession(db: Database, userId: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

/**
 * Validates a presented token. Returns null for unknown, expired, revoked, and
 * belonging-to-a-disabled-user alike — the caller cannot distinguish these, and should
 * not be able to: which one it is is not information a rejected caller needs.
 *
 * Looks up by hash, never by scanning and comparing tokens — the row is found by an
 * indexed equality match on a value the presenter cannot have unless they already hold
 * the real token, so there is nothing timing-sensitive being compared here.
 */
export async function validateSession(
  db: Database,
  token: string,
): Promise<Session | null> {
  const [row] = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      status: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    );

  if (row === undefined || row.status !== 'active') return null;
  return { userId: row.userId, expiresAt: row.expiresAt };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, hashToken(token)));
}

/** Revokes every session for a user — used on password change and account disable. */
export async function revokeAllSessions(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Constant-time compare, exported for callers that need to compare tokens directly. */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
