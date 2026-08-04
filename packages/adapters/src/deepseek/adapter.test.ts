/**
 * `fetch` is mocked with a real `ReadableStream` body — this is the one adapter that
 * actually streams, so the SSE-chunk-splitting logic (`sseData`) is worth exercising
 * against real stream chunk boundaries, not just a pre-parsed array of events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@agentmesh/core';
import { deepseekAdapter } from './adapter.js';

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
 * so the parser has to handle a `data:` line arriving split across reads. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
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

function sseResponse(
  lines: string[],
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: sseStream(lines),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

describe('deepseekAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the run token as Authorization: Bearer through the proxy, requests streaming', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://proxy:3002/providers/deepseek/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer run-token-abc',
    );
    const body = JSON.parse(init.body as string) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it('streams message_delta events as chunks arrive, split across multiple reads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    // The split first chunk never forms a complete `data:` line on its own — this
    // adapter buffers until a full line exists rather than parsing a half-arrived one.
    expect(events).toEqual([
      expect.objectContaining({ type: 'message_delta', text: 'Hello' }),
      expect.objectContaining({ type: 'message_delta', text: ' world' }),
      expect.objectContaining({ type: 'done', outcome: 'succeeded' }),
    ]);
  });

  it('captures usage from the final chunk before [DONE]', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: 'done',
        outcome: 'succeeded',
        usage: { inputTokens: 7, outputTokens: 3, costUsd: null, latencyMs: null },
      }),
    );
  });

  it('emits error + done(failed) on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
      json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'Invalid API key',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('emits error + done(failed) instead of throwing on a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'network unreachable',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('marks the attempt failed when the stream itself carries an error chunk', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'data: {"error":{"message":"context length exceeded"}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of deepseekAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: 'context length exceeded' }),
      expect.objectContaining({ type: 'done', outcome: 'failed' }),
    ]);
  });

  it('declares agentic and toolUse as false, streaming as true', () => {
    expect(deepseekAdapter.capabilities).toMatchObject({
      agentic: false,
      toolUse: false,
      streaming: true,
    });
  });
});
