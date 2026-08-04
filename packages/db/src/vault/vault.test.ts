/**
 * Vault tests against a real Postgres. Skipped without TEST_DATABASE_URL; refuses to
 * skip when one is configured but unreachable (see schema.test.ts for the reasoning).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../client.js';
import { runMigrations } from '../migrate.js';
import { credentials, users } from '../schema.js';
import { Vault, VaultBootError } from './vault.js';
import type { MasterKey } from './master-key.js';

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
    'vault.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

/**
 * Canary rows persist for the life of the test database, so a fixed version number would
 * make a rerun collide with the previous run's key and fail for the wrong reason. Each
 * run gets its own range.
 */
let nextVersion = 1_000 + Math.floor(Math.random() * 1_000_000);
const freshVersion = (): number => (nextVersion += 1);
const masterKey = (version = freshVersion()): MasterKey => ({
  version,
  bytes: randomBytes(32),
});

describeDb('Vault', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function freshUser(): Promise<string> {
    const [row] = await handle.db.insert(users).values({}).returning({ id: users.id });
    return row!.id;
  }

  async function freshVault(): Promise<{ vault: Vault; key: MasterKey }> {
    const key = masterKey();
    const vault = new Vault(handle.db, key);
    await vault.verifyOrInitialize();
    return { vault, key };
  }

  it('round-trips a credential', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    const secret = 'sk-ant-fake-value-for-tests';

    const stored = await vault.putCredential(userId, 'claude', Buffer.from(secret));
    expect(stored.ok).toBe(true);

    const used = await vault.useCredential(userId, 'claude', async (plaintext) =>
      plaintext.toString('utf8'),
    );
    expect(used.ok && used.value).toBe(secret);
  });

  it('stores no plaintext anywhere in the row', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    const secret = 'sk-ant-this-must-never-appear-in-the-database';
    await vault.putCredential(userId, 'claude', Buffer.from(secret));

    const [row] = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, userId));

    // Invariant 1, checked against the actual bytes rather than the column names.
    expect(JSON.stringify(row)).not.toContain('sk-ant-this-must-never');
    expect(row!.ciphertext.toString('utf8')).not.toContain('sk-ant');
  });

  it('wipes the plaintext buffer after the callback returns', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));

    let escaped: Buffer | undefined;
    await vault.useCredential(userId, 'claude', async (plaintext) => {
      escaped = plaintext;
      return null;
    });

    // Best-effort, not a guarantee (SECURITY.md → Zeroization) — but the buffer we were
    // handed must not still hold the key once the scope ends.
    expect(escaped!.every((byte) => byte === 0)).toBe(true);
  });

  it('reports a missing credential rather than throwing', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    const result = await vault.useCredential(userId, 'gemini', async () => 'unreachable');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('not_found');
  });

  /**
   * The attack AAD exists to stop: a row copied onto another user by a database-level
   * compromise or a buggy rotation script. Without AAD the ciphertext is portable and
   * the victim's key silently becomes the attacker's.
   */
  it('refuses a credential row moved to another user', async () => {
    const { vault } = await freshVault();
    const victim = await freshUser();
    const attacker = await freshUser();

    await vault.putCredential(victim, 'claude', Buffer.from('sk-ant-victims-key'));
    const [row] = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, victim));

    // Copy the ciphertext verbatim onto the attacker's account, id and all fields intact
    // apart from the row identity the AAD names.
    await handle.db.insert(credentials).values({
      id: randomUUID(),
      userId: attacker,
      provider: 'claude',
      ciphertext: row!.ciphertext,
      iv: row!.iv,
      tag: row!.tag,
      keyVersion: row!.keyVersion,
    });

    const stolen = await vault.useCredential(attacker, 'claude', async (p) =>
      p.toString('utf8'),
    );
    expect(stolen.ok).toBe(false);
    expect(!stolen.ok && stolen.error.kind).toBe('unreadable');
  });

  it('refuses a credential whose key_version was relabelled', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));

    await handle.db
      .update(credentials)
      .set({ keyVersion: 99 })
      .where(eq(credentials.userId, userId));

    const result = await vault.useCredential(userId, 'claude', async (p) =>
      p.toString('utf8'),
    );
    expect(!result.ok && result.error.kind).toBe('unreadable');
  });

  it('refuses a credential relabelled to another provider', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));

    await handle.db
      .update(credentials)
      .set({ provider: 'gemini' })
      .where(eq(credentials.userId, userId));

    const result = await vault.useCredential(userId, 'gemini', async (p) =>
      p.toString('utf8'),
    );
    expect(!result.ok && result.error.kind).toBe('unreadable');
  });

  it('replaces a credential in place, under a new row identity', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-first'));
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-second'));

    const rows = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, userId));
    expect(rows).toHaveLength(1);

    const used = await vault.useCredential(userId, 'claude', async (p) =>
      p.toString('utf8'),
    );
    expect(used.ok && used.value).toBe('sk-ant-second');
  });

  it('records that a credential was used, never its value', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));
    await vault.useCredential(userId, 'claude', async () => null);

    const [row] = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, userId));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('lists credential metadata without ever returning ciphertext', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));
    await vault.putCredential(userId, 'gemini', Buffer.from('gm-fake'));

    const list = await vault.listCredentials(userId);
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.provider).sort()).toEqual(['claude', 'gemini']);
    // The point of the test: nothing in the summary can be decrypted or is ciphertext.
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual([
        'createdAt',
        'keyVersion',
        'lastUsedAt',
        'provider',
        'updatedAt',
      ]);
    }
  });

  it("does not list another user's credentials", async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    const otherUserId = await freshUser();
    await vault.putCredential(otherUserId, 'claude', Buffer.from('sk-ant-not-yours'));

    expect(await vault.listCredentials(userId)).toEqual([]);
  });

  it('deletes a credential', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-fake'));

    const result = await vault.deleteCredential(userId, 'claude');
    expect(result.ok).toBe(true);
    expect(await vault.listCredentials(userId)).toEqual([]);
  });

  it('reports not_found when deleting a credential that does not exist', async () => {
    const { vault } = await freshVault();
    const userId = await freshUser();

    const result = await vault.deleteCredential(userId, 'claude');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe('not_found');
  });

  it("cannot delete another user's credential", async () => {
    const { vault } = await freshVault();
    const victim = await freshUser();
    const attacker = await freshUser();
    await vault.putCredential(victim, 'claude', Buffer.from('sk-ant-victim'));

    const result = await vault.deleteCredential(attacker, 'claude');
    expect(result.ok).toBe(false);

    const stillThere = await vault.useCredential(victim, 'claude', async (p) =>
      p.toString('utf8'),
    );
    expect(stillThere.ok && stillThere.value).toBe('sk-ant-victim');
  });
});

describeDb('Vault boot check', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('writes a canary on first boot for a version', async () => {
    const key = masterKey();
    await new Vault(handle.db, key).verifyOrInitialize();
    const rows = await handle.db.execute<{ count: string }>(
      sql`select count(*)::text as count from vault_canary where master_key_version = ${key.version}`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('accepts the same key on a later boot', async () => {
    const key = masterKey();
    await new Vault(handle.db, key).verifyOrInitialize();
    await expect(new Vault(handle.db, key).verifyOrInitialize()).resolves.toBeUndefined();
  });

  /** The whole point: a wrong key must refuse to start, not present an empty vault. */
  it('refuses to start under the wrong key', async () => {
    const version = freshVersion();
    await new Vault(handle.db, masterKey(version)).verifyOrInitialize();
    const wrong = masterKey(version); // same version, different bytes
    await expect(new Vault(handle.db, wrong).verifyOrInitialize()).rejects.toThrow(
      VaultBootError,
    );
  });

  it('warns against deleting the canary to get past the error', async () => {
    const version = freshVersion();
    await new Vault(handle.db, masterKey(version)).verifyOrInitialize();
    await expect(
      new Vault(handle.db, masterKey(version)).verifyOrInitialize(),
    ).rejects.toThrow(/Do NOT delete/);
  });

  /**
   * Mid-rotation: v1 and v2 coexist. Boot validation must consider only the version this
   * process holds — a single-row canary would fail here, in the middle of the operation
   * the canary exists to protect.
   */
  it('boots on either version while a rotation is in flight', async () => {
    const v1 = masterKey();
    const v2 = masterKey();
    await new Vault(handle.db, v1).verifyOrInitialize();
    await new Vault(handle.db, v2).verifyOrInitialize();

    await expect(new Vault(handle.db, v1).verifyOrInitialize()).resolves.toBeUndefined();
    await expect(new Vault(handle.db, v2).verifyOrInitialize()).resolves.toBeUndefined();
  });
});
