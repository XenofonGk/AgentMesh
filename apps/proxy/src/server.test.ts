/**
 * The forwarding path, end to end, against a real Postgres-backed Vault and a fake
 * local "Anthropic" — because the properties that matter here (a spoofed header never
 * reaching the upstream, an out-of-allowlist path never being fetched) are only real if
 * proven against an actual HTTP round trip, not asserted against a mock.
 *
 * Skipped without TEST_DATABASE_URL; refuses to skip when one is configured but
 * unreachable (see packages/db/src/schema.test.ts for the reasoning).
 */
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  schema,
  Vault,
  type DatabaseHandle,
  type MasterKey,
} from '@agentmesh/db';
import { buildProxyServer, type ProxyApp } from './server.js';
import type { ProviderRoute } from './providers.js';

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
    'server.test.ts: TEST_DATABASE_URL is set but unreachable. Refusing to skip.',
  );
}

const describeDb = available ? describe : describe.skip;

/** A stand-in Anthropic that records every request it actually received. */
interface FakeUpstream {
  server: Server;
  origin: string;
  requests: Array<{
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('failed to bind fake upstream');
  return { server, origin: `http://127.0.0.1:${address.port}`, requests };
}

describeDb('proxy forwarding path', () => {
  let handle: DatabaseHandle;
  let upstream: FakeUpstream;
  let app: ProxyApp | undefined;

  beforeAll(async () => {
    await runMigrations(CONNECTION);
    handle = createDatabase(CONNECTION);
    upstream = await startFakeUpstream();
  });

  afterEach(async () => {
    await app?.server.close();
    app = undefined;
    upstream.requests.length = 0;
  });

  afterAll(async () => {
    await handle?.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  });

  let nextVersion = 3_000_000 + Math.floor(Math.random() * 1_000_000);
  function testRoutes(): readonly ProviderRoute[] {
    return [
      {
        provider: 'claude',
        origin: upstream.origin,
        paths: new Set(['/v1/messages']),
        authHeader: 'x-api-key',
      },
    ];
  }

  async function freshVault(): Promise<Vault> {
    const masterKey: MasterKey = { version: (nextVersion += 1), bytes: randomBytes(32) };
    const vault = new Vault(handle.db, masterKey);
    await vault.verifyOrInitialize();
    return vault;
  }

  /** No auth flow needed for these tests — just a user id credentials can be scoped to. */
  async function freshUser(): Promise<string> {
    const [row] = await handle.db
      .insert(schema.users)
      .values({})
      .returning({ id: schema.users.id });
    return row!.id;
  }

  it('rejects a request with no run token', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
    });
    expect(response.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown run token', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: { 'x-agentmesh-run-token': 'not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a token that does not permit this provider', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const { token } = app.registry.issue(
      { runId: 'run-1', userId: 'user-1', providers: ['gemini'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: { 'x-agentmesh-run-token': token },
    });
    expect(response.statusCode).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  /**
   * The SSRF guard the user asked to see proven: a path outside the pinned allowlist is
   * refused before any outbound fetch happens — the fake upstream receives nothing.
   */
  it('rejects a path outside the provider allowlist without ever contacting the upstream', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const { token } = app.registry.issue(
      { runId: 'run-1', userId: 'user-1', providers: ['claude'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/some-other-endpoint',
      headers: { 'x-agentmesh-run-token': token },
    });
    expect(response.statusCode).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown provider without ever contacting the upstream', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const { token } = app.registry.issue(
      { runId: 'run-1', userId: 'user-1', providers: ['not-a-real-provider'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/not-a-real-provider/v1/messages',
      headers: { 'x-agentmesh-run-token': token },
    });
    expect(response.statusCode).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('424s when the user has no stored credential for the provider', async () => {
    const vault = await freshVault();
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const userId = await freshUser();
    const { token } = app.registry.issue(
      { runId: 'run-1', userId, providers: ['claude'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: { 'x-agentmesh-run-token': token, 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude', messages: [] }),
    });
    expect(response.statusCode).toBe(424);
    expect(upstream.requests).toHaveLength(0);
  });

  it('injects the real vault-held key and forwards a legitimate request', async () => {
    const vault = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-the-real-key'));
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const { token } = app.registry.issue(
      { runId: 'run-1', userId, providers: ['claude'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: {
        'x-agentmesh-run-token': token,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify({
        model: 'claude-x',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    const upstreamRequest = upstream.requests[0]!;
    expect(upstreamRequest.url).toBe('/v1/messages');
    expect(upstreamRequest.headers['x-api-key']).toBe('sk-ant-the-real-key');
    expect(upstreamRequest.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(upstreamRequest.body)).toEqual({
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  /**
   * The exact attack the header allowlist exists to stop: a runner that sends its own
   * auth-shaped headers must never have them reach the upstream, spoofed value or not.
   */
  it('ignores a runner-supplied x-api-key and Authorization header entirely', async () => {
    const vault = await freshVault();
    const userId = await freshUser();
    await vault.putCredential(userId, 'claude', Buffer.from('sk-ant-the-real-key'));
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });
    const { token } = app.registry.issue(
      { runId: 'run-1', userId, providers: ['claude'] },
      60_000,
    );

    await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: {
        'x-agentmesh-run-token': token,
        'content-type': 'application/json',
        'x-api-key': 'attacker-controlled-value',
        authorization: 'Bearer attacker-controlled-value',
        cookie: 'agentmesh_session=stolen',
      },
      payload: JSON.stringify({ model: 'claude-x', messages: [] }),
    });

    const upstreamRequest = upstream.requests[0]!;
    expect(upstreamRequest.headers['x-api-key']).toBe('sk-ant-the-real-key');
    expect(upstreamRequest.headers['authorization']).toBeUndefined();
    expect(upstreamRequest.headers['cookie']).toBeUndefined();
  });

  it("scopes credential lookup to the run's own user, not whoever the runner claims", async () => {
    const vault = await freshVault();
    const victim = await freshUser();
    const attacker = await freshUser();
    await vault.putCredential(victim, 'claude', Buffer.from('sk-ant-victims-key'));
    app = await buildProxyServer({ vault, providerRoutes: testRoutes() });

    // The attacker's own token is scoped to the attacker's own userId server-side —
    // there is no field in the request the attacker could set to "become" the victim.
    const { token } = app.registry.issue(
      { runId: 'run-attacker', userId: attacker, providers: ['claude'] },
      60_000,
    );

    const response = await app.server.inject({
      method: 'POST',
      url: '/providers/claude/v1/messages',
      headers: { 'x-agentmesh-run-token': token, 'content-type': 'application/json' },
      payload: JSON.stringify({ model: 'claude-x', messages: [] }),
    });

    // The attacker has no credential of their own — 424, never the victim's key.
    expect(response.statusCode).toBe(424);
    expect(upstream.requests).toHaveLength(0);
  });
});
