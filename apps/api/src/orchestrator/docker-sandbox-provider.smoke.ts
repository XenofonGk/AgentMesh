/**
 * Adversarial smoke test for `DockerSandboxProvider`, run by hand against a real Docker
 * daemon: `pnpm --filter @agentmesh/api exec tsx src/orchestrator/docker-sandbox-provider.smoke.ts`
 *
 * Not part of `pnpm test` — CI has no Docker-in-Docker, and the vacuous-green trap this
 * is written against is exactly what unit tests against `FakeSandboxProvider` cannot
 * catch: they prove the *code calls the Docker API correctly*, never that Docker
 * *honored* the hardening flags. So every check here tries to do the thing the
 * hardening is supposed to prevent, and passes only if that thing fails:
 *
 *   - write outside the workspace              (ReadonlyRootfs)
 *   - exec a script staged in /tmp              (Tmpfs noexec)
 *   - bind a privileged port                    (CapDrop + non-root)
 *   - run a setuid binary for a raw socket      (SecurityOpt no-new-privileges + CapDrop)
 *   - reach a host off the sandbox's network     (network topology: internal-only)
 *   - out-survive a SIGTERM-ignoring process     (destroy()'s stop-then-remove path)
 *
 * A check that can't fail is not a check — see CLAUDE.md's own no-op-hooks lesson.
 */
/* eslint-disable no-console -- a CLI smoke script; console output is the report. */
import Docker from 'dockerode';
import { DockerSandboxProvider } from './docker-sandbox-provider.js';

const IMAGE = 'node:22-alpine';
const docker = new Docker();

let failures = 0;

function report(name: string, ok: boolean, detail?: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function execIn(
  containerId: string,
  cmd: readonly string[],
): Promise<{ exitCode: number; output: string }> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: [...cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  const inspection = await exec.inspect();
  return {
    exitCode: inspection.ExitCode ?? -1,
    output: Buffer.concat(chunks).toString('utf8'),
  };
}

async function ensureNetwork(name: string, internal: boolean): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (networks.some((n) => n.Name === name)) return;
  await docker.createNetwork({ Name: name, Internal: internal });
}

async function main(): Promise<void> {
  const provider = new DockerSandboxProvider({ docker });

  await ensureNetwork('agentmesh-smoke-internal', true);

  console.log('--- rootfs, tmpfs, workspace ---');
  {
    const sandbox = await provider.create({
      image: IMAGE,
      command: ['sh', '-c', 'sleep 120'],
      env: {},
      networks: ['agentmesh-smoke-internal'],
      resources: { cpus: 1, memoryMb: 256 },
      timeoutMs: 120_000,
    });

    const writeOutsideWorkspace = await execIn(sandbox.id, [
      'sh',
      '-c',
      'touch /etc/smoke-test-file',
    ]);
    report(
      'read-only rootfs blocks writes outside the workspace',
      writeOutsideWorkspace.exitCode !== 0,
      writeOutsideWorkspace.output.trim(),
    );

    const stageAndExec = await execIn(sandbox.id, [
      'sh',
      '-c',
      "echo '#!/bin/sh\\necho pwned' > /tmp/x && chmod +x /tmp/x && /tmp/x",
    ]);
    report(
      '/tmp is noexec — a staged script cannot be run',
      stageAndExec.exitCode !== 0,
      stageAndExec.output.trim(),
    );

    await provider.destroy(sandbox.id);
  }

  console.log('--- workspace mount stays writable ---');
  {
    const sandbox = await provider.create({
      image: IMAGE,
      command: ['sh', '-c', 'sleep 120'],
      env: {},
      networks: ['agentmesh-smoke-internal'],
      resources: { cpus: 1, memoryMb: 256 },
      timeoutMs: 120_000,
      workspace: { hostPath: '/tmp', containerPath: '/workspace' },
    });

    const writeInWorkspace = await execIn(sandbox.id, [
      'sh',
      '-c',
      'touch /workspace/agentmesh-smoke-workspace-write',
    ]);
    report(
      'the workspace mount is writable',
      writeInWorkspace.exitCode === 0,
      writeInWorkspace.output.trim(),
    );

    await provider.destroy(sandbox.id);
  }

  console.log('--- capabilities, privilege escalation ---');
  {
    const sandbox = await provider.create({
      image: IMAGE,
      command: ['sh', '-c', 'sleep 120'],
      env: {},
      networks: ['agentmesh-smoke-internal'],
      resources: { cpus: 1, memoryMb: 256 },
      timeoutMs: 120_000,
    });

    // `timeout` wraps both: a successful bind/raw-socket would otherwise hang the
    // command waiting on a connection/reply, not fail fast — the wrapper turns "capped
    // out" into a distinguishable exit code instead of the whole check hanging. GNU
    // coreutils' `timeout` exits 124 on expiry; busybox's (what's actually on
    // node:22-alpine) kills with SIGTERM and the shell reports that as 128+15=143 — both
    // mean the same thing here: the command was still running, i.e. the bind/socket
    // succeeded, which is the failure case for these checks.
    const TIMED_OUT = new Set([124, 143]);

    const bindPrivilegedPort = await execIn(sandbox.id, [
      'timeout',
      '3',
      'nc',
      '-l',
      '-p',
      '80',
    ]);
    report(
      'binding a privileged port fails (non-root + CAP_NET_BIND_SERVICE dropped)',
      bindPrivilegedPort.exitCode !== 0 && !TIMED_OUT.has(bindPrivilegedPort.exitCode),
      `exit ${bindPrivilegedPort.exitCode.toString()}: ${bindPrivilegedPort.output.trim()}`,
    );

    const rawSocketPing = await execIn(sandbox.id, [
      'timeout',
      '3',
      'ping',
      '-c',
      '1',
      '127.0.0.1',
    ]);
    report(
      'ping (needs a raw socket / setuid escalation) fails under no-new-privileges + CapDrop',
      rawSocketPing.exitCode !== 0 && !TIMED_OUT.has(rawSocketPing.exitCode),
      `exit ${rawSocketPing.exitCode.toString()}: ${rawSocketPing.output.trim()}`,
    );

    await provider.destroy(sandbox.id);
  }

  console.log('--- network topology ---');
  {
    const sandbox = await provider.create({
      image: IMAGE,
      command: ['sh', '-c', 'sleep 120'],
      env: {},
      networks: ['agentmesh-smoke-internal'],
      resources: { cpus: 1, memoryMb: 256 },
      timeoutMs: 120_000,
    });

    const reachExternal = await execIn(sandbox.id, [
      'wget',
      '-T',
      '4',
      '-O',
      '/dev/null',
      'http://93.184.216.34',
    ]);
    report(
      'a container on an internal-only network cannot reach an external host',
      reachExternal.exitCode !== 0,
      reachExternal.output.trim(),
    );

    await provider.destroy(sandbox.id);
  }

  console.log('--- teardown of a SIGTERM-ignoring container ---');
  {
    const sandbox = await provider.create({
      image: IMAGE,
      command: ['sh', '-c', "trap '' TERM; while true; do sleep 1; done"],
      env: {},
      networks: ['agentmesh-smoke-internal'],
      resources: { cpus: 1, memoryMb: 256 },
      timeoutMs: 120_000,
    });

    const start = Date.now();
    await provider.destroy(sandbox.id);
    const elapsedMs = Date.now() - start;

    const inspectAfterDestroy = await docker
      .getContainer(sandbox.id)
      .inspect()
      .then(() => true)
      .catch(() => false);

    report(
      'destroy() tears down a container that ignores SIGTERM',
      !inspectAfterDestroy,
      `container still present after destroy: ${inspectAfterDestroy}, took ${elapsedMs.toString()}ms`,
    );
  }

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures.toString()} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});
