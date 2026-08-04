/**
 * `fetch` is mocked — no real network. What's under test is normalization of a
 * `generateContent` response into `AgentEvent`s, the credential boundary (the run
 * token travels as `x-goog-api-key`, sent through the proxy, never a real key held
 * here), and error handling (non-2xx response, malformed body, network failure).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '@agentmesh/core';
import { geminiAdapter } from './adapter.js';

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    attemptId: 'attempt-1',
    proxyUrl: 'http://proxy:3002',
    runToken: 'run-token-abc',
    workspacePath: '/workspace',
    ...overrides,
  };
}

describe('geminiAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the run token as x-goog-api-key through the proxy, never a real credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://proxy:3002/providers/gemini/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'run-token-abc',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'say hi' }] }],
    });
  });

  it('normalizes a successful response into message_delta + done(succeeded) with usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [
            { content: { parts: [{ text: 'Hello there' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'message_delta',
        role: 'assistant',
        text: 'Hello there',
        provider: 'gemini',
      }),
      expect.objectContaining({
        type: 'done',
        outcome: 'succeeded',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: null, latencyMs: null },
      }),
    ]);
  });

  it('joins multiple text parts into one message_delta', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'message_delta', text: 'Hello world' }),
    );
  });

  it('emits error + done(failed) on a non-2xx response, using the API error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: { message: 'API key not valid' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'API key not valid',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('emits error + done(failed) when the response body is not valid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('unexpected token')),
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'error', recoverable: false }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('emits error + done(failed) instead of throwing on a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of geminiAdapter.run({ task: 'say hi' }, ctx())) {
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

  it('declares agentic, toolUse, and streaming as false — no capability it does not have', () => {
    expect(geminiAdapter.capabilities).toMatchObject({
      agentic: false,
      toolUse: false,
      streaming: false,
    });
  });
});
