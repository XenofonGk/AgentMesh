/**
 * Credential routes against a real Postgres and a real Vault — the seam where auth and
 * the vault actually meet. Skipped without TEST_DATABASE_URL; refuses to skip when one
 * is configured but unreachable (see packages/db/src/schema.test.ts for the reasoning).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  createUserWithPassword,
  createSession,
  runMigrations,
  Vault,
  type DatabaseHandle,
  type MasterKey,
} from '@agentmesh/db';
import { buildServer, type App } from '../server.js';
import { loadConfig } from '../config.js';
import { SESSION_COOKIE_NAME } from '../auth/session-cookie.js';

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? '';

async function reachable(): Promise<boolean> {
  if (CONNECTION === '') return false;
  const probe = createDatabase(CONNECTION);
  try {
    return await probe.ping();
  } finally {
    await probe.close();
  }
}

const available = await reachable();
if (CONNECTION !== '' && !available) {
  throw new Error(
    'routes.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

describeDb('credential routes', () => {
  let handle: DatabaseHandle;
  let app: App | undefined;
  const config = loadConfig({
    DATABASE_URL: CONNECTION,
    WEB_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
  });

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
  });

  afterEach(async () => {
    await app?.server.close();
    app = undefined;
  });

  afterAll(async () => {
    await handle?.close();
  });

  /** Each test gets its own key version so canaries never collide across runs. */
  let nextVersion = 2_000_000 + Math.floor(Math.random() * 1_000_000);
  async function freshApp(): Promise<{ app: App; cookie: string; userId: string }> {
    const masterKey: MasterKey = { version: (nextVersion += 1), bytes: randomBytes(32) };
    const vault = new Vault(handle.db, masterKey);
    await vault.verifyOrInitialize();

    const built = await buildServer({ config, database: handle, vault });
    app = built;

    const email = `${randomUUID()}@example.test`;
    const { userId } = await createUserWithPassword(
      handle.db,
      email,
      'a genuinely long passphrase',
    );
    const token = await createSession(handle.db, userId);

    return { app: built, cookie: `${SESSION_COOKIE_NAME}=${token}`, userId };
  }

  it('rejects every credential route without a session', async () => {
    const masterKey: MasterKey = { version: (nextVersion += 1), bytes: randomBytes(32) };
    const vault = new Vault(handle.db, masterKey);
    await vault.verifyOrInitialize();
    app = await buildServer({ config, database: handle, vault });

    const get = await app.server.inject({ method: 'GET', url: '/credentials' });
    expect(get.statusCode).toBe(401);

    const put = await app.server.inject({
      method: 'PUT',
      url: '/credentials/claude',
      payload: { apiKey: 'sk-ant-fake' },
    });
    expect(put.statusCode).toBe(401);

    const del = await app.server.inject({ method: 'DELETE', url: '/credentials/claude' });
    expect(del.statusCode).toBe(401);
  });

  it('stores a credential and lists it back without the secret', async () => {
    const { app, cookie } = await freshApp();

    const put = await app.server.inject({
      method: 'PUT',
      url: '/credentials/claude',
      headers: { cookie },
      payload: { apiKey: 'sk-ant-fake-value-for-tests' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ provider: 'claude', keyVersion: 1 });

    const list = await app.server.inject({
      method: 'GET',
      url: '/credentials',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { credentials: Array<Record<string, unknown>> };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]!['provider']).toBe('claude');

    // The point of the test: the secret is nowhere in the response body.
    expect(JSON.stringify(body)).not.toContain('sk-ant-fake-value-for-tests');
  });

  it('rejects a malformed provider name', async () => {
    const { app, cookie } = await freshApp();

    const put = await app.server.inject({
      method: 'PUT',
      url: '/credentials/Not Valid!',
      headers: { cookie },
      payload: { apiKey: 'sk-ant-fake' },
    });
    expect(put.statusCode).toBe(400);
  });

  it('rejects an empty api key', async () => {
    const { app, cookie } = await freshApp();

    const put = await app.server.inject({
      method: 'PUT',
      url: '/credentials/claude',
      headers: { cookie },
      payload: { apiKey: '' },
    });
    expect(put.statusCode).toBe(400);
  });

  it('deletes a credential', async () => {
    const { app, cookie } = await freshApp();

    await app.server.inject({
      method: 'PUT',
      url: '/credentials/claude',
      headers: { cookie },
      payload: { apiKey: 'sk-ant-fake' },
    });

    const del = await app.server.inject({
      method: 'DELETE',
      url: '/credentials/claude',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.server.inject({
      method: 'GET',
      url: '/credentials',
      headers: { cookie },
    });
    expect((list.json() as { credentials: unknown[] }).credentials).toEqual([]);
  });

  it('404s deleting a credential that does not exist', async () => {
    const { app, cookie } = await freshApp();

    const del = await app.server.inject({
      method: 'DELETE',
      url: '/credentials/claude',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });

  /**
   * The property that actually matters: one user's session cannot see, overwrite, or
   * delete another user's credentials, even for the same provider name.
   */
  it('isolates credentials between users', async () => {
    const victim = await freshApp();
    await victim.app.server.inject({
      method: 'PUT',
      url: '/credentials/claude',
      headers: { cookie: victim.cookie },
      payload: { apiKey: 'sk-ant-victims-key' },
    });
    await victim.app.server.close();
    app = undefined;

    const attacker = await freshApp();

    // Attacker's own list is empty — victim's row does not show up.
    const list = await attacker.app.server.inject({
      method: 'GET',
      url: '/credentials',
      headers: { cookie: attacker.cookie },
    });
    expect((list.json() as { credentials: unknown[] }).credentials).toEqual([]);

    // Attacker "deleting" the same provider name only ever touches their own (empty) set.
    const del = await attacker.app.server.inject({
      method: 'DELETE',
      url: '/credentials/claude',
      headers: { cookie: attacker.cookie },
    });
    expect(del.statusCode).toBe(404);
  });
});
