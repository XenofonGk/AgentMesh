/**
 * The sandbox contract every runner container is created through — PLAN.md §D4.
 *
 * A domain interface, not a Docker-specific one, on purpose: "Docker is the correct
 * answer here because the operator trusts their users (D5). That assumption is doing
 * real work — if it ever stops being true, the isolation model must change, since
 * Docker shares the host kernel." This interface is what makes that swap possible
 * without touching the orchestrator — a microVM backend (Firecracker, Kata) implements
 * the same three methods. It also means the orchestrator is testable against a fake
 * with no real container runtime involved.
 *
 * What this interface does *not* decide: how hardening (non-root, read-only rootfs,
 * dropped capabilities, resource limits) is expressed. That's implementation-specific —
 * Docker's `HostConfig` shape has nothing in common with a microVM's — so `RunSpec`
 * states the *requirements* in runtime-neutral terms, and each `SandboxProvider`
 * implementation is responsible for actually enforcing every one of them.
 */

export interface ResourceLimits {
  /** Fractional CPUs, e.g. 1.5. */
  cpus: number;
  memoryMb: number;
}

export interface RunSpec {
  /**
   * The caller's own identifier for this sandbox — an attempt id, say — distinct from
   * `Sandbox.id`, which the provider assigns once the sandbox actually exists. Not
   * every provider needs it (an in-process fake can ignore it entirely), but a
   * provider that runs out-of-process — the HTTP broker client, for one — needs
   * something to name the request by before any backend id exists yet.
   */
  id: string;
  image: string;
  /** The command run as the sandbox's own entrypoint — not something exec'd in later. */
  command: readonly string[];
  /**
   * Non-secret environment only. Invariant 6: runner containers never receive API keys
   * via env, file, or argument — a `SandboxProvider` implementation must not be handed
   * one to violate that with, so this is typed as the whole environment, not "everything
   * except secrets," to keep that a property of what's constructed, not what's omitted.
   */
  env: Readonly<Record<string, string>>;
  /**
   * Named networks to attach, and nothing else — no default network, no host network
   * mode. In the Docker implementation this is what actually enforces invariant 3: a
   * runner's only network is the internal, egress-restricted one shared with the proxy.
   */
  networks: readonly string[];
  resources: ResourceLimits;
  /** Hard wall-clock timeout. The sandbox is destroyed if it outlives this. */
  timeoutMs: number;
  /** Mounted read-write at `containerPath`; everything else in the sandbox is read-only. */
  workspace?: { hostPath: string; containerPath: string };
}

export interface Sandbox {
  id: string;
}

export type SandboxOutput =
  { stream: 'stdout' | 'stderr'; chunk: Buffer } | { stream: 'exit'; exitCode: number };

/**
 * costs ~20 lines, keeps the orchestrator testable with a fake — PLAN.md §D4.
 *
 * `logs` is additive to the three methods PLAN.md names (`create`, `exec`, `destroy`):
 * the orchestrator needs to stream a sandbox's own entrypoint output, which is a
 * different thing from `exec`ing an extra command into an already-running sandbox.
 */
export interface SandboxProvider {
  create(spec: RunSpec): Promise<Sandbox>;
  /** The sandbox's own process output, from the moment `create` started it. */
  logs(id: string): AsyncIterable<SandboxOutput>;
  exec(id: string, cmd: readonly string[]): AsyncIterable<SandboxOutput>;
  destroy(id: string): Promise<void>;
}
