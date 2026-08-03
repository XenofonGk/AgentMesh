/**
 * Password hashing. Argon2id via `@node-rs/argon2` — prebuilt native bindings, no
 * compile step, so `pnpm install` works the same on a dev machine and inside the
 * Alpine API image (musl binary resolved from `optionalDependencies` at install time).
 *
 * Never bcrypt/scrypt here: this project's schema comment already commits to Argon2id
 * (`auth_identities.password_hash`), and mixing hash families mid-project means either a
 * silent downgrade path or a painful migration. Pick one, once.
 */
import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-recommended baseline for Argon2id (19 MiB is the *library's* naming of
 * `m_cost` in KiB, i.e. ~19 MiB memory, t_cost 2, 1 lane) is too weak for a credential
 * vault's front door. This project protects provider API keys, not a forum login, so it
 * costs more: ~64 MiB, 3 iterations. Tune later against real server hardware — the
 * hash string embeds its own parameters, so raising these never invalidates existing
 * hashes; only lowering them would.
 */
const ARGON2_OPTIONS = {
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Returns false for a wrong password *and* for a malformed hash — a corrupted
 * `password_hash` column must fail closed, not throw past the login handler and risk
 * an error path that behaves differently from a rejection.
 */
export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
