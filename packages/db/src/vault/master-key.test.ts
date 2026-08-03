import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadMasterKey, PLACEHOLDER_MASTER_KEY } from './master-key.js';

const VALID = randomBytes(32).toString('base64');

describe('loadMasterKey', () => {
  it('accepts a 32-byte base64 key', () => {
    const key = loadMasterKey({ env: { VAULT_MASTER_KEY: VALID } });
    expect(key.bytes).toHaveLength(32);
    expect(key.version).toBe(1);
  });

  it('reads VAULT_MASTER_KEY_FILE, for Docker secrets', () => {
    const key = loadMasterKey({
      env: { VAULT_MASTER_KEY_FILE: '/run/secrets/vault_key' },
      readFile: () => `${VALID}\n`,
    });
    expect(key.bytes).toHaveLength(32);
  });

  it('refuses when both sources are set', () => {
    expect(() =>
      loadMasterKey({
        env: { VAULT_MASTER_KEY: VALID, VAULT_MASTER_KEY_FILE: '/run/secrets/vault_key' },
      }),
    ).toThrow(/exactly one/i);
  });

  it('refuses when nothing is configured', () => {
    expect(() => loadMasterKey({ env: {} })).toThrow(/VAULT_MASTER_KEY/);
  });

  it('refuses the placeholder from .env.example', () => {
    expect(() =>
      loadMasterKey({ env: { VAULT_MASTER_KEY: PLACEHOLDER_MASTER_KEY } }),
    ).toThrow(/placeholder/i);
  });

  it('refuses a key of the wrong length', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => loadMasterKey({ env: { VAULT_MASTER_KEY: short } })).toThrow(/32 bytes/);
  });

  it('refuses input that is not valid base64', () => {
    // Buffer.from is lenient and would otherwise decode this to *something*.
    expect(() =>
      loadMasterKey({ env: { VAULT_MASTER_KEY: 'not base64 at all!!' } }),
    ).toThrow(/base64/i);
  });

  it('reports an unreadable key file by path', () => {
    expect(() =>
      loadMasterKey({
        env: { VAULT_MASTER_KEY_FILE: '/run/secrets/missing' },
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/\/run\/secrets\/missing/);
  });

  it('parses a rotation version', () => {
    expect(
      loadMasterKey({ env: { VAULT_MASTER_KEY: VALID, VAULT_MASTER_KEY_VERSION: '2' } })
        .version,
    ).toBe(2);
    expect(() =>
      loadMasterKey({
        env: { VAULT_MASTER_KEY: VALID, VAULT_MASTER_KEY_VERSION: 'two' },
      }),
    ).toThrow(/positive integer/);
  });

  /** Invariant 1 reaches error messages too — this is where secrets usually escape. */
  it('never echoes any part of the key', () => {
    const secret = randomBytes(16).toString('base64');
    for (const env of [
      { VAULT_MASTER_KEY: secret },
      { VAULT_MASTER_KEY: `${secret}!!` },
      { VAULT_MASTER_KEY: secret, VAULT_MASTER_KEY_FILE: '/x' },
    ]) {
      try {
        loadMasterKey({ env });
      } catch (error) {
        const message = String(error);
        expect(message).not.toContain(secret);
        expect(message).not.toContain(secret.slice(0, 8));
      }
    }
  });

  it('tells the operator how to generate a real one', () => {
    expect(() => loadMasterKey({ env: {} })).toThrow(/openssl rand -base64 32/);
  });
});
