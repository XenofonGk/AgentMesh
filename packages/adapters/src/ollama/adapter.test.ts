/**
 * Same shape as `grok/adapter.test.ts` and `deepseek/adapter.test.ts`, adapted for
 * Ollama's NDJSON stream instead of SSE — real chunk-boundary splitting matters here
 * too, so `ndjson` is exercised against a stream that splits a JSON object mid-line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@agentmesh/core';
import { ollamaAdapter } from './adapter.js';

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    attemptId: 'attempt-1',
    proxyUrl: 'http://proxy:3002',
    runToken: 'run-token-abc',
    workspacePath: '/workspace',
    ...overrides,
  };
}

/** A stream that yields each string as its own chunk — deliberately not one big write,
 * so the parser has to handle a JSON line arriving split across reads. */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(lines[index] as string));
      index++;
    },
  });
}

function chatResponse(
  lines: string[],
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: ndjsonStream(lines),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

describe('ollamaAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares no credential schema — the no-credential-path control case', () => {
    expect(ollamaAdapter.credentialSchema).toBeNull();
  });

  it('never reads a provider credential from its environment', async () => {
    const originalEnv = { ...process.env };
    process.env['OLLAMA_API_KEY'] = 'should-never-be-read';
    process.env['ANTHROPIC_API_KEY'] = 'should-never-be-read';
    try {
      const fetchMock = vi.fn().mockResolvedValue(chatResponse(['']));
      vi.stubGlobal('fetch', fetchMock);

      const events = [];
      for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
        events.push(event);
      }

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const sentText = JSON.stringify(init) + JSON.stringify(events);
      expect(sentText).not.toContain('should-never-be-read');
    } finally {
      process.env = originalEnv;
    }
  });

  it('calls the proxy, not Ollama directly, sending the run token as Authorization: Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse(['']));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://proxy:3002/providers/ollama/api/chat');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer run-token-abc',
    );
    const body = JSON.parse(init.body as string) as { stream: boolean; model: string };
    expect(body.stream).toBe(true);
    expect(typeof body.model).toBe('string');
  });

  it('streams message_delta events from NDJSON chunks split across multiple reads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        chatResponse([
          '{"message":{"role":"assistant","content":"Hel',
          'lo"},"done":false}\n',
          '{"message":{"role":"assistant","content":" world"},"done":false}\n',
          '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":2}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'message_delta', text: 'Hello' }),
      expect.objectContaining({ type: 'message_delta', text: ' world' }),
      expect.objectContaining({
        type: 'done',
        outcome: 'succeeded',
        usage: { inputTokens: 5, outputTokens: 2, costUsd: null, latencyMs: null },
      }),
    ]);
  });

  it('emits error + done(failed) on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
      json: () => Promise.resolve({ error: 'model "llama3.1" not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'model "llama3.1" not found',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('emits error + done(failed) instead of throwing on a network failure (e.g. Ollama not running)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'fetch failed',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('marks the attempt failed when a stream line carries an error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(chatResponse(['{"error":"model is overloaded"}\n']));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: 'model is overloaded' }),
      expect.objectContaining({ type: 'done', outcome: 'failed' }),
    ]);
  });

  it('drops a malformed NDJSON line rather than throwing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        chatResponse([
          'not json at all\n',
          '{"message":{"role":"assistant","content":"ok"},"done":false}\n',
          '{"done":true}\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of ollamaAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'message_delta', text: 'ok' }),
      expect.objectContaining({ type: 'done', outcome: 'succeeded' }),
    ]);
  });

  it('declares agentic and toolUse as false, streaming as true', () => {
    expect(ollamaAdapter.capabilities).toMatchObject({
      agentic: false,
      toolUse: false,
      streaming: true,
    });
  });
});
