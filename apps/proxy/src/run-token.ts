/**
 * Run tokens — how a runner is granted credentialed egress without ever naming a
 * credential.
 *
 * ## The rule
 *
 * The runner says **"I am run R"**. It never says "give me credential C".
 *
 * A `SecretRef` that is redeemable by whoever presents it is a capability, and a
 * compromised or prompt-injected runner will simply present a different one. Guessing a
 * uuid is not the only way to get one either: refs travel through logs, run records, and
 * error payloads. The runner must not be able to *express* the request in the first
 * place.
 *
 * So the mapping run → credential lives here, server-side. The proxy issues an opaque
 * token when it starts a run, hands it to the container, and on each request looks up
 * what that token is entitled to. A runner that asks for someone else's key has no
 * syntax in which to ask.
 *
 * ## Properties
 *
 * - **Opaque and random.** 32 bytes from a CSPRNG. It names nothing and encodes nothing;
 *   there is no user id or credential id to tamper with, because there are no fields.
 * - **Stored hashed.** Only the SHA-256 lives in the registry, so a dump of proxy state
 *   or a leaked log line does not yield a usable token. Same reasoning as `sessions`.
 * - **Scoped to one run.** Revoked when the run ends. A container that outlives its run
 *   holds a token that resolves to nothing.
 * - **Scoped to a provider set.** A run declares which providers it will talk to when the
 *   token is issued. A Claude run cannot use the token to spend the user's Gemini
 *   credit — the entitlement was fixed before the agent started executing.
 * - **Constant-time lookup.** Comparison is over a hash in a Map, so token validity is
 *   not probeable by timing.
 *
 * In-memory on purpose: a run token must not outlive the proxy process that issued it,
 * and there is exactly one proxy per instance. Persisting them would create a second
 * place credentials-adjacent state can leak from, for no benefit.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

/** What a token is entitled to. Derived server-side; never supplied by the runner. */
export interface RunGrant {
  runId: string;
  userId: string;
  /** Exactly the providers this run may reach. Fixed at issue time. */
  providers: readonly string[];
  expiresAt: Date;
}

export interface IssuedToken {
  /** Given to the container once, at startup. Never logged, never persisted. */
  token: string;
  grant: RunGrant;
}

function hash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export class RunTokenRegistry {
  private readonly grants = new Map<string, RunGrant>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(grant: Omit<RunGrant, 'expiresAt'>, ttlMs: number): IssuedToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const full: RunGrant = {
      ...grant,
      expiresAt: new Date(this.now().getTime() + ttlMs),
    };
    this.grants.set(hash(token).toString('hex'), full);
    return { token, grant: full };
  }

  /**
   * Resolves a presented token to what it may do. Returns null for unknown, expired, or
   * revoked tokens — the caller cannot distinguish those cases, and should not be able
   * to: telling a runner "that token existed but expired" is information it has no use
   * for and an attacker does.
   */
  resolve(token: string): RunGrant | null {
    const digest = hash(token);
    const stored = this.grants.get(digest.toString('hex'));
    if (stored === undefined) return null;

    if (stored.expiresAt.getTime() <= this.now().getTime()) {
      this.grants.delete(digest.toString('hex'));
      return null;
    }
    return stored;
  }

  /**
   * Whether a grant covers a provider. The proxy calls this with the provider it derived
   * from the *request's destination*, never from a header the runner controls.
   */
  static permits(grant: RunGrant, provider: string): boolean {
    return grant.providers.some((allowed) => {
      const a = Buffer.from(allowed, 'utf8');
      const b = Buffer.from(provider, 'utf8');
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  /** Called when a run ends. A container outliving its run holds a dead token. */
  revoke(runId: string): void {
    for (const [digest, grant] of this.grants) {
      if (grant.runId === runId) this.grants.delete(digest);
    }
  }

  /** Housekeeping; expiry is also enforced on every resolve. */
  pruneExpired(): void {
    const now = this.now().getTime();
    for (const [digest, grant] of this.grants) {
      if (grant.expiresAt.getTime() <= now) this.grants.delete(digest);
    }
  }

  get size(): number {
    return this.grants.size;
  }
}
