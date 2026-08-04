/**
 * The credential vault.
 *
 * Envelope encryption: the master key wraps a per-user DEK; the DEK seals that user's
 * credentials. Rotating the master key re-wraps DEKs and touches no credential row.
 *
 * The only module permitted to read the `credentials` table (enforced by
 * `packages/core/src/provider.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { type Result, ok, err } from '@agentmesh/core';
import type { Database } from '../client.js';
import { credentials, userKeys, vaultCanary } from '../schema.js';
import {
  CANARY_PLAINTEXT,
  canaryAad,
  credentialAad,
  dekAad,
  equals,
  generateKey,
  open,
  seal,
  wipe,
  withSecret,
} from './crypto.js';
import type { MasterKey } from './master-key.js';

export type VaultFailure =
  | { kind: 'not_found'; provider: string }
  | { kind: 'no_key_for_user'; userId: string }
  /** Authentication failed: wrong key, moved row, or relabelled version. */
  | { kind: 'unreadable'; provider: string; keyVersion: number };

/**
 * Everything about a stored credential except the secret itself. What a "manage my
 * credentials" UI needs to render a list — never ciphertext, never plaintext.
 */
export interface CredentialSummary {
  provider: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export class VaultBootError extends Error {
  override readonly name = 'VaultBootError';
}

export class Vault {
  constructor(
    private readonly db: Database,
    private readonly masterKey: MasterKey,
  ) {}

  /**
   * Boot check. Proves this master key is the one the stored data was encrypted under,
   * before a single request is served.
   *
   * Three outcomes:
   *   no canary for this version  → first boot on this key; write one
   *   canary decrypts             → correct key
   *   canary present, won't open  → **wrong key**; refuse to start
   *
   * The third case is the reason this exists. Without it, a wrong key is
   * indistinguishable from an empty vault, and the user is invited to re-enter their
   * credentials on top of ciphertext that is now unrecoverable.
   *
   * Other versions' canaries are ignored on purpose: during a rotation v1 and v2 coexist
   * legitimately, and failing on a version this process does not hold would break boot
   * in the middle of the operation the canary is meant to protect.
   */
  async verifyOrInitialize(): Promise<void> {
    const { version, bytes } = this.masterKey;

    const [existing] = await this.db
      .select()
      .from(vaultCanary)
      .where(eq(vaultCanary.masterKeyVersion, version));

    if (existing === undefined) {
      const box = seal(bytes, CANARY_PLAINTEXT, canaryAad(version));
      await this.db.insert(vaultCanary).values({ masterKeyVersion: version, ...box });
      return;
    }

    const opened = open(bytes, existing, canaryAad(version));
    if (opened === null || !equals(opened, CANARY_PLAINTEXT)) {
      wipe(opened);
      throw new VaultBootError(
        `The configured vault master key (version ${version}) does not match the key this ` +
          'data was encrypted with. Refusing to start.\n\n' +
          'Do NOT delete the vault_canary row to get past this — the stored credentials ' +
          'would still be unreadable, and re-entering them would encrypt new values on top ' +
          'of ciphertext you can no longer recover. Restore the correct ' +
          'VAULT_MASTER_KEY (and VAULT_MASTER_KEY_VERSION, if you were rotating).',
      );
    }
    wipe(opened);
  }

  /**
   * Returns the user's active DEK, creating one on first use. The DEK is returned
   * unwrapped, so every caller must scope it — see {@link withSecret}.
   */
  private async activeDek(
    userId: string,
  ): Promise<Result<{ key: Buffer; generation: number }>> {
    const [row] = await this.db
      .select()
      .from(userKeys)
      .where(and(eq(userKeys.userId, userId), isNull(userKeys.retiredAt)));

    if (row === undefined) {
      const key = generateKey();
      const generation = 1;
      const box = seal(
        this.masterKey.bytes,
        key,
        dekAad(userId, generation, this.masterKey.version),
      );
      await this.db.insert(userKeys).values({
        userId,
        generation,
        wrappedDek: box.ciphertext,
        iv: box.iv,
        tag: box.tag,
        masterKeyVersion: this.masterKey.version,
      });
      return ok({ key, generation });
    }

    const key = open(
      this.masterKey.bytes,
      { ciphertext: row.wrappedDek, iv: row.iv, tag: row.tag },
      dekAad(userId, row.generation, row.masterKeyVersion),
    );

    if (key === null) {
      return err(new Error(`vault: DEK for user ${userId} did not authenticate`));
    }
    return ok({ key, generation: row.generation });
  }

  /**
   * Stores a provider credential.
   *
   * `credentialId` is generated here rather than by the database default, because it is
   * part of the AAD — the row's identity has to exist before the ciphertext that names
   * it. A DB-assigned id would mean sealing against an id we do not yet know.
   */
  async putCredential(
    userId: string,
    provider: string,
    plaintext: Buffer,
  ): Promise<Result<{ credentialId: string; keyVersion: number }>> {
    const dek = await this.activeDek(userId);
    if (!dek.ok) return dek;

    try {
      const credentialId = randomUUID();
      const { key, generation } = dek.value;
      const box = seal(key, plaintext, credentialAad(credentialId, provider, generation));

      await this.db
        .insert(credentials)
        .values({
          id: credentialId,
          userId,
          provider,
          ciphertext: box.ciphertext,
          iv: box.iv,
          tag: box.tag,
          keyVersion: generation,
        })
        .onConflictDoUpdate({
          target: [credentials.userId, credentials.provider],
          set: {
            // A replaced credential is a new row identity: the AAD names the id, so
            // reusing the old one would bind new ciphertext to a stale identity.
            id: credentialId,
            ciphertext: box.ciphertext,
            iv: box.iv,
            tag: box.tag,
            keyVersion: generation,
            updatedAt: new Date(),
          },
        });

      return ok({ credentialId, keyVersion: generation });
    } finally {
      wipe(dek.value.key, plaintext);
    }
  }

  /**
   * Decrypts a credential and hands it to `use`, wiping it afterwards. There is no
   * variant that returns the plaintext: invariant 4 says a decrypted key exists only
   * within one request's scope, and a function that returns one makes that unenforceable.
   */
  async useCredential<T>(
    userId: string,
    provider: string,
    use: (secret: Buffer) => Promise<T>,
  ): Promise<Result<T, VaultFailure>> {
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, userId), eq(credentials.provider, provider)));

    if (row === undefined) return err({ kind: 'not_found', provider });

    const dek = await this.activeDek(userId);
    if (!dek.ok) return err({ kind: 'no_key_for_user', userId });

    let plaintext: Buffer | null = null;
    try {
      plaintext = open(
        dek.value.key,
        { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
        // Binds the row to its own id, provider, and DEK generation. A row copied from
        // another user, or relabelled to a different version, fails here.
        credentialAad(row.id, row.provider, row.keyVersion),
      );

      if (plaintext === null) {
        return err({ kind: 'unreadable', provider, keyVersion: row.keyVersion });
      }

      const result = await withSecret(plaintext, use);
      // Records *that* it was used, never the value (§4, audit).
      await this.db
        .update(credentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(credentials.id, row.id));

      return ok(result);
    } finally {
      wipe(dek.value.key, plaintext);
    }
  }

  /**
   * Metadata only. The column list is explicit rather than `select()` precisely so that
   * adding a sensitive column to `credentials` later can't silently start flowing
   * through this method into an API response — a reviewer has to touch this line too.
   */
  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    return this.db
      .select({
        provider: credentials.provider,
        keyVersion: credentials.keyVersion,
        createdAt: credentials.createdAt,
        updatedAt: credentials.updatedAt,
        lastUsedAt: credentials.lastUsedAt,
      })
      .from(credentials)
      .where(eq(credentials.userId, userId));
  }

  /**
   * Deletes a stored credential. No decryption involved — deleting a row you cannot
   * read is still a correct delete, so this does not go through `activeDek`.
   */
  async deleteCredential(
    userId: string,
    provider: string,
  ): Promise<Result<void, { kind: 'not_found'; provider: string }>> {
    const deleted = await this.db
      .delete(credentials)
      .where(and(eq(credentials.userId, userId), eq(credentials.provider, provider)))
      .returning({ id: credentials.id });

    if (deleted.length === 0) return err({ kind: 'not_found', provider });
    return ok(undefined);
  }
}
