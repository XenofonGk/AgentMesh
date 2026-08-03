/**
 * Loading and validating the vault master key.
 *
 * Failures here are startup failures. An instance that boots without a usable master key
 * is an instance that will present an empty vault to a user who then re-enters their API
 * keys on top of ciphertext nobody can read again.
 */
import { readFileSync } from 'node:fs';
import { KEY_BYTES, wipe } from './crypto.js';

/**
 * The literal value shipped in `.env.example`. Hardcoded because people copy the file
 * and never change it, and an instance running on a key that is public in the repository
 * has no vault at all.
 */
export const PLACEHOLDER_MASTER_KEY = 'REPLACE_ME_RUN_openssl_rand_base64_32';

export interface MasterKey {
  version: number;
  /** 32 bytes. Never logged, never serialized, never leaves this process. */
  bytes: Buffer;
}

export class MasterKeyError extends Error {
  override readonly name = 'MasterKeyError';
}

/**
 * Every message names the variable and the fix, and none of them echo any part of the
 * value — not a prefix, not a length-revealing excerpt. A misconfiguration is usually
 * diagnosed from someone's terminal scrollback or a CI log.
 */
function fail(message: string): never {
  throw new MasterKeyError(
    `${message}\n\nGenerate one with:  openssl rand -base64 32\n` +
      'Set VAULT_MASTER_KEY, or VAULT_MASTER_KEY_FILE pointing at a file containing it ' +
      '(for Docker/Podman secrets).',
  );
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to reading the filesystem. */
  readFile?: (path: string) => string;
}

export function loadMasterKey(options: LoadOptions = {}): MasterKey {
  const env = options.env ?? process.env;
  const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const inline = env['VAULT_MASTER_KEY']?.trim() ?? '';
  const filePath = env['VAULT_MASTER_KEY_FILE']?.trim() ?? '';

  if (inline !== '' && filePath !== '') {
    fail(
      'Both VAULT_MASTER_KEY and VAULT_MASTER_KEY_FILE are set. Set exactly one — ' +
        'guessing which takes precedence is how an instance silently runs on the wrong key.',
    );
  }

  let encoded: string;
  if (filePath !== '') {
    try {
      encoded = read(filePath).trim();
    } catch {
      // The path itself is not secret, and naming it is the whole diagnostic value.
      fail(`VAULT_MASTER_KEY_FILE is set but "${filePath}" could not be read.`);
    }
  } else if (inline !== '') {
    encoded = inline;
  } else {
    fail(
      'No vault master key configured. Set VAULT_MASTER_KEY or VAULT_MASTER_KEY_FILE.',
    );
  }

  if (encoded === '') {
    fail('The vault master key is empty.');
  }

  if (encoded === PLACEHOLDER_MASTER_KEY) {
    fail(
      'The vault master key is still the placeholder value from .env.example. That value ' +
        'is public in the repository, so every credential encrypted under it is readable ' +
        'by anyone.',
    );
  }

  // Round-trip check: Buffer.from is lenient and silently drops invalid characters, so a
  // typo'd key would otherwise decode to *something* and be accepted.
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    wipe(bytes);
    fail('The vault master key is not valid base64.');
  }

  if (bytes.length !== KEY_BYTES) {
    const actual = bytes.length;
    wipe(bytes);
    fail(
      `The vault master key must decode to exactly ${KEY_BYTES} bytes; this one is ${actual}.`,
    );
  }

  return { version: parseVersion(env['VAULT_MASTER_KEY_VERSION']), bytes };
}

/**
 * Which key generation this is. Defaults to 1; the operator increments it when rotating,
 * which is what lets the canary table hold both the old and new key during a rotation.
 */
function parseVersion(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    fail(`VAULT_MASTER_KEY_VERSION must be a positive integer; got "${raw}".`);
  }
  return version;
}
