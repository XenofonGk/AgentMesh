/**
 * The real `SandboxProvider` — dockerode against the local Docker socket.
 *
 * Every hardening flag PLAN.md §4 lists for the runner container is set here, not left
 * to a default: non-root, read-only rootfs, dropped capabilities, no new privileges,
 * resource limits, and — the property that matters most for this pass — a network
 * allowlist expressed as "attach only the named networks in `spec.networks`," never the
 * bridge network Docker would otherwise attach by default. That absence of a default
 * network is invariant 3's actual enforcement mechanism; see `packages/core/src/sandbox.ts`.
 */
import Docker from 'dockerode';
import type { RunSpec, Sandbox, SandboxOutput, SandboxProvider } from '@agentmesh/core';

export interface DockerSandboxOptions {
  /** Injectable so tests can point at a fake Docker daemon; defaults to the local socket. */
  docker?: Docker;
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly docker: Docker;

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = options.docker ?? new Docker();
  }

  async create(spec: RunSpec): Promise<Sandbox> {
    const binds = spec.workspace
      ? [`${spec.workspace.hostPath}:${spec.workspace.containerPath}:rw`]
      : [];

    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: [...spec.command],
      Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
      // No default network. NetworkMode 'none' at create time; the actual networks in
      // spec.networks are attached explicitly below, after creation — createContainer's
      // own NetworkingConfig option only reliably attaches the *first* named network,
      // so every network beyond that is joined via an explicit connect call.
      NetworkDisabled: false,
      HostConfig: {
        NetworkMode: spec.networks[0] ?? 'none',
        Binds: binds,
        ReadonlyRootfs: true,
        // The workspace mount is the one place that must stay writable; everything
        // else in the container is read-only, per PLAN.md §4.
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        NanoCpus: Math.round(spec.resources.cpus * 1_000_000_000),
        Memory: spec.resources.memoryMb * 1024 * 1024,
        // CapDrop alone does not stop two things modern kernels allow any UID to do
        // without capabilities, both namespaced sysctls that default to "allow
        // everyone" on many distros — so both have to be pinned closed per-container
        // rather than trusted as a host default:
        //   - ping_group_range: opens an unprivileged ICMP "ping socket" without
        //     CAP_NET_RAW.
        //   - ip_unprivileged_port_start: lets a non-root UID bind ports below 1024
        //     without CAP_NET_BIND_SERVICE.
        // Both confirmed live by docker-sandbox-provider.smoke.ts, which found `ping`
        // and binding port 80 both succeeding under CapDrop: ['ALL'] + User: '1000:1000'
        // before this was added.
        Sysctls: {
          'net.ipv4.ping_group_range': '0 0',
          'net.ipv4.ip_unprivileged_port_start': '1024',
        },
        // Wall-clock enforcement lives in the orchestrator (setTimeout -> destroy), not
        // here — Docker has no native "kill after N ms" primitive to delegate to.
      },
      // A container never runs as root — invariant-adjacent hardening PLAN.md §4 lists
      // explicitly, and unrelated to which user the image's own Dockerfile declares.
      User: '1000:1000',
    });

    for (const network of spec.networks.slice(1)) {
      await this.docker.getNetwork(network).connect({ Container: container.id });
    }

    await container.start();
    return { id: container.id };
  }

  async *logs(id: string): AsyncIterable<SandboxOutput> {
    const container = this.docker.getContainer(id);
    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });
    yield* demuxDockerStream(stream as NodeJS.ReadableStream);
  }

  async *exec(id: string, cmd: readonly string[]): AsyncIterable<SandboxOutput> {
    const container = this.docker.getContainer(id);
    const exec = await container.exec({
      Cmd: [...cmd],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    yield* demuxDockerStream(stream as unknown as NodeJS.ReadableStream);

    const inspection = await exec.inspect();
    yield { stream: 'exit', exitCode: inspection.ExitCode ?? -1 };
  }

  async destroy(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      await container.stop({ t: 5 });
    } catch {
      // Already stopped or already gone — destroy is idempotent by design, since the
      // orchestrator's timeout path and its normal-completion path can both call it.
    }
    try {
      await container.remove({ force: true });
    } catch {
      // Same reasoning: already removed is a successful destroy, not a failure.
    }
  }
}

/**
 * Docker multiplexes stdout/stderr onto one stream with an 8-byte frame header per
 * chunk (stream type + length) when a container was created without a TTY, which this
 * one always is. `dockerode`'s own `demuxStream` helper writes to two `Writable`s
 * rather than yielding, so this reimplements the same framing as an async generator to
 * fit `SandboxOutput`.
 */
async function* demuxDockerStream(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<SandboxOutput> {
  let buffer = Buffer.alloc(0);

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 8) {
      const streamType = buffer.readUInt8(0);
      const frameLength = buffer.readUInt32BE(4);
      if (buffer.length < 8 + frameLength) break;

      const payload = buffer.subarray(8, 8 + frameLength);
      buffer = buffer.subarray(8 + frameLength);

      yield {
        stream: streamType === 2 ? 'stderr' : 'stdout',
        chunk: Buffer.from(payload),
      };
    }
  }
}
