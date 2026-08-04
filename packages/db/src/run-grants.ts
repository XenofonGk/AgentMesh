/**
 * Run grants — what a runner's token is entitled to, shared between the process that
 * issues them (the orchestrator, inside the API) and the process that resolves them on
 * every forwarded request (the proxy). See `schema.ts`'s comment on `runGrants` for why
 * this is a table rather than the in-memory registry an earlier version used: two
 * processes needed to agree on the same state, and Postgres is the channel both of them
 * already trust.
 *
 * The rule this module exists to enforce is the same one from the proxy's own design:
 * **the runner says "I am run R," never "give me credential C."** A token here names
 * nothing — it is 32 random bytes the runner presents, and every other field (which
 * user, which provider, which attempt) is looked up server-side from what the token
 * hashes to. There is no field a caller can set to change whose credential a token
 * reaches.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { runGrants } from './schema.js';

const TOKEN_BYTES = 32;

export interface RunGrant {
  attemptId: string;
  userId: string;
  provider: string;
  expiresAt: Date;
}

export interface IssuedRunToken {
  /** Given to the container once, at startup. Never logged, never persisted. */
  token: string;
  grant: RunGrant;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Issued by the orchestrator when it starts a sandbox for one attempt. */
export async function issueRunToken(
  db: Database,
  grant: { attemptId: string; userId: string; provider: string },
  ttlMs: number,
): Promise<IssuedRunToken> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(runGrants).values({
    tokenHash: hashToken(token),
    attemptId: grant.attemptId,
    userId: grant.userId,
    provider: grant.provider,
    expiresAt,
  });

  return { token, grant: { ...grant, expiresAt } };
}

/**
 * Resolved by the proxy on every forwarded request. Returns null for unknown, expired,
 * and revoked tokens alike — the caller cannot distinguish those cases, and should not
 * be able to: telling a runner "that token existed but expired" is information it has
 * no use for and an attacker does.
 *
 * A single indexed equality lookup on the hash — nothing timing-sensitive to guard
 * here, since finding the row at all already requires holding the real token.
 */
export async function resolveRunToken(
  db: Database,
  token: string,
): Promise<RunGrant | null> {
  const [row] = await db
    .select({
      attemptId: runGrants.attemptId,
      userId: runGrants.userId,
      provider: runGrants.provider,
      expiresAt: runGrants.expiresAt,
    })
    .from(runGrants)
    .where(
      and(
        eq(runGrants.tokenHash, hashToken(token)),
        isNull(runGrants.revokedAt),
        gt(runGrants.expiresAt, new Date()),
      ),
    );

  return row ?? null;
}

/** Whether a grant covers a provider. Not a secret comparison — `provider` isn't one. */
export function grantPermits(grant: RunGrant, provider: string): boolean {
  return grant.provider === provider;
}

/** Called when an attempt ends. A container that outlives its attempt holds a dead token. */
export async function revokeRunGrant(db: Database, attemptId: string): Promise<void> {
  await db
    .update(runGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(runGrants.attemptId, attemptId), isNull(runGrants.revokedAt)));
}
