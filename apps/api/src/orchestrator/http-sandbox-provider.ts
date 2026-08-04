/**
 * The API's own implementation of `SandboxProvider` — not Docker, an HTTP client for
 * `@agentmesh/broker`. The API never holds the Docker socket; see broker/src/server.ts
 * for why. `exec` is intentionally unimplemented: nothing in this codebase calls it yet
 * (the orchestrator only creates and destroys), and the broker doesn't expose it either
 * — add both together if a caller ever needs it, rather than half-wiring one side now.
 */
import type { RunSpec, Sandbox, SandboxOutput, SandboxProvider } from '@agentmesh/core';

export interface HttpSandboxOptions {
  brokerUrl: string;
}

export class HttpSandboxProvider implements SandboxProvider {
  constructor(private readonly options: HttpSandboxOptions) {}

  async create(spec: RunSpec): Promise<Sandbox> {
    const response = await fetch(`${this.options.brokerUrl}/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        attemptId: spec.id,
        image: spec.image,
        env: spec.env,
        resources: spec.resources,
        timeoutMs: spec.timeoutMs,
      }),
    });

    if (!response.ok) {
      throw new Error(`broker refused to create sandbox: ${response.status.toString()}`);
    }

    const body = (await response.json()) as { id: string };
    return { id: body.id };
  }

  async *logs(id: string): AsyncIterable<SandboxOutput> {
    const response = await fetch(`${this.options.brokerUrl}/sandboxes/${id}/logs`);
    if (!response.ok || !response.body) {
      throw new Error(`broker refused to stream logs: ${response.status.toString()}`);
    }

    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
      buffer += chunk.toString('utf8');
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;
        yield deserializeOutput(JSON.parse(line) as SerializedOutput);
      }
    }
  }

  exec(_id: string, _cmd: readonly string[]): AsyncIterable<SandboxOutput> {
    throw new Error(
      'HttpSandboxProvider does not implement exec — see class doc comment',
    );
  }

  async destroy(id: string): Promise<void> {
    const response = await fetch(`${this.options.brokerUrl}/sandboxes/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`broker refused to destroy sandbox: ${response.status.toString()}`);
    }
  }
}

type SerializedOutput =
  { stream: 'stdout' | 'stderr'; chunk: string } | { stream: 'exit'; exitCode: number };

function deserializeOutput(output: SerializedOutput): SandboxOutput {
  if (output.stream === 'exit') {
    return output;
  }
  return { stream: output.stream, chunk: Buffer.from(output.chunk, 'base64') };
}
