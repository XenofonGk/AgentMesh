/**
 * The narrow HTTP surface the API talks to instead of holding the Docker socket
 * itself. The API is the most exposed process in this system (it's what a browser
 * talks to); the Docker socket is host-root-equivalent. Putting both in the same
 * process makes the sandbox decorative — a compromised API would just ask its own
 * socket for a privileged container. This process is what actually holds the socket,
 * and its request schema is the containment: there is no field for `image` (only an
 * allowlisted name), no field for `Privileged`, no field for an arbitrary bind mount.
 * See `allowlist.ts`.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SandboxOutput, SandboxProvider } from '@agentmesh/core';
import { resolveAllowedImage } from './allowlist.js';

/** Server-side ceilings — a caller's requested values are clamped, never trusted whole. */
const MAX_CPUS = 2;
const MAX_MEMORY_MB = 4096;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const CreateSandboxBody = z.object({
  attemptId: z.string().uuid(),
  image: z.string().min(1).max(256),
  env: z.record(z.string(), z.string()).default({}),
  resources: z
    .object({
      cpus: z.number().positive().max(MAX_CPUS).default(1),
      memoryMb: z.number().int().positive().max(MAX_MEMORY_MB).default(2048),
    })
    .default({ cpus: 1, memoryMb: 2048 }),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .default(10 * 60 * 1000),
});

export interface BuildBrokerOptions {
  sandbox: SandboxProvider;
  workspaceRoot: string;
  runnerNetwork: string;
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface BrokerApp {
  server: FastifyInstance;
}

export async function buildBrokerServer({
  sandbox,
  workspaceRoot,
  runnerNetwork,
  logLevel,
}: BuildBrokerOptions): Promise<BrokerApp> {
  const server = Fastify({ logger: { level: logLevel ?? 'info' } });

  server.get('/health', () => ({ status: 'ok' as const }));

  server.post('/sandboxes', async (request, reply) => {
    const body = CreateSandboxBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const allowed = resolveAllowedImage(body.data.image);
    if (!allowed) {
      return reply.code(400).send({ error: 'image_not_allowed' });
    }

    // Generated here, never accepted from the caller — the one field the prompt this
    // was built against called out by name ("workspacePath") is exactly the one a
    // compromised caller could otherwise turn into an arbitrary host bind mount.
    const hostPath = path.join(workspaceRoot, body.data.attemptId);
    await mkdir(hostPath, { recursive: true });

    const created = await sandbox.create({
      id: body.data.attemptId,
      image: allowed.image,
      command: allowed.command,
      env: body.data.env,
      // Not read from the request: every sandbox goes on the one network the runner is
      // ever allowed to reach, full stop.
      networks: [runnerNetwork],
      resources: body.data.resources,
      timeoutMs: body.data.timeoutMs,
      workspace: { hostPath, containerPath: '/workspace' },
    });

    return reply.code(201).send({ id: created.id });
  });

  server.delete('/sandboxes/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    await sandbox.destroy(params.data.id);
    return reply.code(204).send();
  });

  // NDJSON, one SandboxOutput per line — deliberately not SSE (the API is the only
  // caller, not a browser) and not chunked JSON arrays (the client needs to start
  // reading before the sandbox exits).
  server.get('/sandboxes/:id/logs', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_id' });
    }

    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for await (const output of sandbox.logs(params.data.id)) {
      reply.raw.write(`${JSON.stringify(serializeOutput(output))}\n`);
    }
    reply.raw.end();
    return reply;
  });

  return { server };
}

function serializeOutput(output: SandboxOutput): unknown {
  if (output.stream === 'exit') {
    return output;
  }
  return { stream: output.stream, chunk: output.chunk.toString('base64') };
}
