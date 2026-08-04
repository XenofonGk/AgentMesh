/**
 * The broker's containment lives in its request schema, so this is what these tests
 * actually check: an unlisted image is rejected, the caller cannot supply a workspace
 * path or a network, and resource/timeout values outside the server-side ceiling are
 * rejected rather than silently clamped-and-accepted from a bad actor's perspective.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBrokerServer, type BrokerApp } from './server.js';
import { FakeSandboxProvider } from './fake-sandbox-provider.js';

describe('broker server', () => {
  let app: BrokerApp;
  let sandbox: FakeSandboxProvider;
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'agentmesh-broker-test-'));
    sandbox = new FakeSandboxProvider();
    app = await buildBrokerServer({
      sandbox,
      workspaceRoot,
      runnerNetwork: 'internal',
      logLevel: 'silent',
    });
  });

  afterEach(async () => {
    await app.server.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('creates a sandbox for an allowlisted image', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: { attemptId: randomUUID(), image: 'agentmesh/claude:latest', env: {} },
    });

    expect(response.statusCode).toBe(201);
    expect(sandbox.sandboxes.size).toBe(1);
  });

  it('rejects an image that is not on the allowlist', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: { attemptId: randomUUID(), image: 'evil/rootkit:latest', env: {} },
    });

    expect(response.statusCode).toBe(400);
    expect(sandbox.sandboxes.size).toBe(0);
  });

  it('ignores any network the caller supplies and always uses the runner network', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: {
        attemptId: randomUUID(),
        image: 'agentmesh/claude:latest',
        env: {},
        // Not a field the schema recognizes at all — proves the point rather than
        // asserting on it by name, since a schema with `.strict()` would reject it and
        // one without simply drops it. Either way it cannot reach the sandbox spec.
        networks: ['bridge', 'host'],
      },
    });

    expect(response.statusCode).toBe(201);
    const [record] = sandbox.sandboxes.values();
    expect(record?.spec.networks).toEqual(['internal']);
  });

  it('generates the workspace path itself rather than accepting one from the caller', async () => {
    const attemptId = randomUUID();
    const response = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: {
        attemptId,
        image: 'agentmesh/claude:latest',
        env: {},
        workspace: { hostPath: '/etc', containerPath: '/workspace' },
      },
    });

    expect(response.statusCode).toBe(201);
    const [record] = sandbox.sandboxes.values();
    expect(record?.spec.workspace?.hostPath).toBe(path.join(workspaceRoot, attemptId));
    expect(record?.spec.workspace?.hostPath).not.toBe('/etc');
  });

  it('rejects resource requests above the server-side ceiling', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: {
        attemptId: randomUUID(),
        image: 'agentmesh/claude:latest',
        env: {},
        resources: { cpus: 64, memoryMb: 2048 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(sandbox.sandboxes.size).toBe(0);
  });

  it('destroys a sandbox by id', async () => {
    const create = await app.server.inject({
      method: 'POST',
      url: '/sandboxes',
      payload: { attemptId: randomUUID(), image: 'agentmesh/claude:latest', env: {} },
    });
    const { id } = create.json<{ id: string }>();

    const response = await app.server.inject({
      method: 'DELETE',
      url: `/sandboxes/${id}`,
    });

    expect(response.statusCode).toBe(204);
    expect(sandbox.sandboxes.get(id)?.destroyed).toBe(true);
  });
});
