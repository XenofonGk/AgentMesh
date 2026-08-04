/** In-memory `SandboxProvider` double for `server.test.ts` — no Docker involved. */
import type { RunSpec, Sandbox, SandboxOutput, SandboxProvider } from '@agentmesh/core';

export interface FakeSandboxRecord {
  id: string;
  spec: RunSpec;
  destroyed: boolean;
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly sandboxes = new Map<string, FakeSandboxRecord>();
  private nextId = 0;

  create(spec: RunSpec): Promise<Sandbox> {
    const id = `fake-sandbox-${(this.nextId++).toString()}`;
    this.sandboxes.set(id, { id, spec, destroyed: false });
    return Promise.resolve({ id });
  }

  logs(_id: string): AsyncIterable<SandboxOutput> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: true as const, value: undefined }),
        };
      },
    };
  }

  exec(_id: string, _cmd: readonly string[]): AsyncIterable<SandboxOutput> {
    throw new Error('not used by server.test.ts');
  }

  destroy(id: string): Promise<void> {
    const record = this.sandboxes.get(id);
    if (record) {
      record.destroyed = true;
    }
    return Promise.resolve();
  }
}
