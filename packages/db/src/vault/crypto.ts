/**
 * AES-256-GCM primitives for the vault.
 *
 * ## Everything is bound to where it lives
 *
 * Every ciphertext carries additional authenticated data naming its own location. AAD
 * is authenticated but not encrypted: change it and decryption fails with a bad auth
 * tag rather than returning wrong plaintext.
 *
 * Without it, a ciphertext is a portable blob. Someone with UPDATE on the database —
 * or a bug in a rotation script — can copy user A's credential row onto user B's, and
 * every check in the system still passes: the row decrypts, the tag verifies, and B is
 * now spending A's key. Binding the row's identity into the AAD makes that a decryption
 * failure. It also pins `key_version`: relabelling a row as a different DEK generation
 * to dodge a rotation stops working, because the version is part of what was signed.
 *
 * This is the one property that genuinely cannot be added later. AAD is mixed into the
 * authentication tag at encryption time, so introducing it after the fact means
 * decrypting and re-encrypting every stored credential under the old key — the exact
 * migration-over-live-ciphertext that the schema was designed to avoid.
 *
 * ## Plaintext is always a Buffer
 *
 * Never a string. See `SECURITY.md` → Zeroization: strings are immutable and cannot be
 * overwritten, so a plaintext string persists in the heap until it is collected, and
 * every substring or concatenation makes another copy. Buffers can at least be
 * overwritten on a best-effort basis.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
/** 96 bits — the size GCM is specified for; anything else invites nonce-reuse analysis. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/** Ciphertext plus the pieces needed to authenticate it. Never contains plaintext. */
export interface SealedBox {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Domain separator. Prevents a sealed box from one context (a wrapped DEK) being
 * accepted in another (a credential), even if an attacker could line up the fields.
 */
const AAD_PREFIX = 'agentmesh.v1';

/** AAD for a stored credential: its row identity and the DEK generation that sealed it. */
export function credentialAad(
  credentialId: string,
  provider: string,
  keyVersion: number,
): Buffer {
  return Buffer.from(
    `${AAD_PREFIX}:credential:${credentialId}:${provider}:${keyVersion}`,
    'utf8',
  );
}

/** AAD for a wrapped DEK: whose it is, which generation, and which master key wrapped it. */
export function dekAad(
  userId: string,
  generation: number,
  masterKeyVersion: number,
): Buffer {
  return Buffer.from(
    `${AAD_PREFIX}:dek:${userId}:${generation}:${masterKeyVersion}`,
    'utf8',
  );
}

/** AAD for a canary: the master key version it proves. */
export function canaryAad(masterKeyVersion: number): Buffer {
  return Buffer.from(`${AAD_PREFIX}:canary:${masterKeyVersion}`, 'utf8');
}

/** The fixed plaintext every canary seals. Its value is not secret; its readability is. */
export const CANARY_PLAINTEXT = Buffer.from('agentmesh.vault.canary', 'utf8');

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): SealedBox {
  if (key.length !== KEY_BYTES) {
    throw new Error(`seal: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/**
 * Returns null when the box does not authenticate under this key and AAD — a wrong key,
 * a moved row, a relabelled version, or tampering. The caller cannot tell which, and
 * deliberately so: distinguishing them for the caller is an oracle.
 */
export function open(key: Buffer, box: SealedBox, aad: Buffer): Buffer | null {
  if (key.length !== KEY_BYTES) return null;
  if (box.iv.length !== IV_BYTES || box.tag.length !== TAG_BYTES) return null;

  try {
    const decipher = createDecipheriv(ALGORITHM, key, box.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(box.tag);
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  } catch {
    // A failed tag check throws. Nothing here is loggable — not the key, not the box.
    return null;
  }
}

/**
 * Best-effort overwrite of key material. See SECURITY.md → Zeroization: this reduces the
 * window in which a heap dump yields a key. It does not guarantee the bytes are gone,
 * because a copying garbage collector may have moved the buffer already.
 */
export function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

/**
 * Runs `use` with the plaintext, then wipes it. The value must not escape the callback —
 * that is the whole point of the shape (invariant 4).
 */
export async function withSecret<T>(
  secret: Buffer,
  use: (secret: Buffer) => Promise<T>,
): Promise<T> {
  try {
    return await use(secret);
  } finally {
    wipe(secret);
  }
}

/** Constant-time compare, for anything an attacker can submit repeatedly. */
export function equals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
