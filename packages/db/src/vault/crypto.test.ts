import { describe, expect, it } from 'vitest';
import {
  CANARY_PLAINTEXT,
  canaryAad,
  credentialAad,
  dekAad,
  generateKey,
  open,
  seal,
  wipe,
} from './crypto.js';

const SECRET = Buffer.from('sk-ant-a-totally-fake-key-for-tests', 'utf8');

describe('seal/open', () => {
  it('round-trips under the same key and AAD', () => {
    const key = generateKey();
    const aad = credentialAad('cred-1', 'claude', 1);
    const opened = open(key, seal(key, Buffer.from(SECRET), aad), aad);
    expect(opened?.toString('utf8')).toBe(SECRET.toString('utf8'));
  });

  it('fails under a different key', () => {
    const aad = credentialAad('cred-1', 'claude', 1);
    const box = seal(generateKey(), Buffer.from(SECRET), aad);
    expect(open(generateKey(), box, aad)).toBeNull();
  });

  it('fails when the ciphertext is tampered with', () => {
    const key = generateKey();
    const aad = credentialAad('cred-1', 'claude', 1);
    const box = seal(key, Buffer.from(SECRET), aad);
    box.ciphertext[0] = box.ciphertext[0]! ^ 0xff;
    expect(open(key, box, aad)).toBeNull();
  });
});

/**
 * The properties AAD exists for. Each of these is a real attack: a row moved between
 * users by a database-level compromise or a buggy rotation script, or a version
 * relabelled to make a stale row look current.
 */
describe('AAD binds ciphertext to its location', () => {
  const key = generateKey();

  it('refuses a credential moved to another row id', () => {
    const box = seal(key, Buffer.from(SECRET), credentialAad('cred-A', 'claude', 1));
    expect(open(key, box, credentialAad('cred-B', 'claude', 1))).toBeNull();
  });

  it('refuses a credential relabelled to another provider', () => {
    const box = seal(key, Buffer.from(SECRET), credentialAad('cred-A', 'claude', 1));
    expect(open(key, box, credentialAad('cred-A', 'gemini', 1))).toBeNull();
  });

  it('refuses a credential whose key_version was relabelled', () => {
    const box = seal(key, Buffer.from(SECRET), credentialAad('cred-A', 'claude', 1));
    expect(open(key, box, credentialAad('cred-A', 'claude', 2))).toBeNull();
  });

  it('refuses a DEK moved to another user', () => {
    const box = seal(key, generateKey(), dekAad('user-A', 1, 1));
    expect(open(key, box, dekAad('user-B', 1, 1))).toBeNull();
  });

  it('refuses a DEK relabelled to another generation or master key version', () => {
    const box = seal(key, generateKey(), dekAad('user-A', 1, 1));
    expect(open(key, box, dekAad('user-A', 2, 1))).toBeNull();
    expect(open(key, box, dekAad('user-A', 1, 2))).toBeNull();
  });

  it('refuses a canary presented as a different key version', () => {
    const box = seal(key, CANARY_PLAINTEXT, canaryAad(1));
    expect(open(key, box, canaryAad(2))).toBeNull();
  });

  it('keeps the three AAD domains separate', () => {
    // Same identifiers in each; only the domain tag differs. A sealed DEK must never be
    // openable as a credential.
    const box = seal(key, Buffer.from(SECRET), dekAad('x', 1, 1));
    expect(open(key, box, credentialAad('x', '1', 1))).toBeNull();
  });
});

describe('wipe', () => {
  it('overwrites buffer contents', () => {
    const buffer = Buffer.from(SECRET);
    wipe(buffer);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it('tolerates null and undefined', () => {
    expect(() => wipe(null, undefined)).not.toThrow();
  });
});
