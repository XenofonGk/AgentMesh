/**
 * In-memory `SandboxProvider` for orchestrator unit tests — no Docker daemon involved.
 * Records every `create`/`destroy` call so tests can assert on lifecycle without
 * inspecting real containers.
 */
import type { RunSpec, Sandbox, SandboxOutput, SandboxProvider } from '@agentmesh/core';

export interface FakeSandboxRecord {
  id: string;
  spec: RunSpec;
  destroyed: boolean;
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, FakeSandboxRecord>();
  /** How many times `destroy` was actually called — what an idempotency test asserts on. */
  destroyCallCount = 0;
  private nextId = 0;

  async create(spec: RunSpec): Promise<Sandbox> {
    const id = `fake-sandbox-${(this.nextId++).toString()}`;
    this.sandboxes.set(id, { id, spec, destroyed: false });
    return Promise.resolve({ id });
  }

  async *logs(_id: string): AsyncIterable<SandboxOutput> {
    for (const output of [] as SandboxOutput[]) {
      yield output;
    }
  }

  async *exec(_id: string, _cmd: readonly string[]): AsyncIterable<SandboxOutput> {
    yield { stream: 'exit', exitCode: 0 };
  }

  async destroy(id: string): Promise<void> {
    this.destroyCallCount++;
    const record = this.sandboxes.get(id);
    if (record) {
      record.destroyed = true;
    }
    return Promise.resolve();
  }
}
