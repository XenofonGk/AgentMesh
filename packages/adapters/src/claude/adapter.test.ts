/**
 * `query()` is mocked — no real subprocess, no real network. What's under test is the
 * normalization (`toAgentEvents`, exercised through `run()`) and the credential
 * boundary: this adapter must ask `@anthropic-ai/claude-agent-sdk` to use the run token
 * as its "API key" and never fall through to a real one sitting in `process.env`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunContext } from '@agentmesh/core';

const queryMock =
  vi.fn<(args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>>();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options?: Options }) => queryMock(args),
}));

const { claudeAdapter } = await import('./adapter.js');

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    attemptId: 'attempt-1',
    proxyUrl: 'http://proxy:3002',
    runToken: 'run-token-abc',
    workspacePath: '/workspace',
    ...overrides,
  };
}

async function* fakeStream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) yield message;
}

describe('claudeAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('never reads ANTHROPIC_API_KEY from its own environment — it sets one from the run token', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'a-real-credential-that-must-never-be-used';
    queryMock.mockReturnValue(fakeStream([]));

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(queryMock).toHaveBeenCalledTimes(1);
    const options = queryMock.mock.calls[0]![0].options!;
    expect(options.env?.['ANTHROPIC_API_KEY']).toBe('run-token-abc');
    expect(options.env?.['ANTHROPIC_BASE_URL']).toBe(
      'http://proxy:3002/providers/claude',
    );
  });

  it('normalizes a text delta stream event into message_delta', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hi' },
          },
          parent_tool_use_id: null,
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage,
      ]),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'message_delta',
        role: 'assistant',
        text: 'hi',
        provider: 'claude',
      }),
    ]);
  });

  it('normalizes a tool_use block into tool_call, and Edit tool_use into an additional file_edit', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tc1',
                name: 'Edit',
                input: { file_path: '/workspace/a.ts' },
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage,
      ]),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ type: 'tool_call', toolCallId: 'tc1', name: 'Edit' }),
      expect.objectContaining({ type: 'file_edit', path: '/workspace/a.ts' }),
    ]);
  });

  it('normalizes a tool_result content block', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tc1', content: 'ok', is_error: false },
            ],
          },
          parent_tool_use_id: null,
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage,
      ]),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      }),
    ]);
  });

  it('normalizes a result message into a single done event with usage', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          total_cost_usd: 0.0042,
          duration_ms: 1234,
          usage: { input_tokens: 100, output_tokens: 50 },
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage,
      ]),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'done',
        outcome: 'succeeded',
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0042, latencyMs: 1234 },
      }),
    ]);
  });

  it('emits error + done(failed) instead of throwing when the stream itself blows up', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('subprocess spawn failed');
    });

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'subprocess spawn failed',
        recoverable: false,
      }),
      expect.objectContaining({ type: 'done', outcome: 'failed', usage: null }),
    ]);
  });

  it('emits error + done(failed) on a mid-stream disconnect', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'partial' },
          },
          parent_tool_use_id: null,
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage;
        throw new Error('connection reset');
      })(),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'message_delta', text: 'partial' }),
    );
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: 'error',
        message: 'connection reset',
        recoverable: false,
      }),
    );
    expect(events[2]).toEqual(
      expect.objectContaining({ type: 'done', outcome: 'failed' }),
    );
  });

  it('surfaces an SDKAssistantMessage.error (e.g. authentication_failed) as an error event', async () => {
    queryMock.mockReturnValue(
      fakeStream([
        {
          type: 'assistant',
          error: 'authentication_failed',
          message: { content: [] },
          parent_tool_use_id: null,
          uuid: 'u1',
          session_id: 's1',
        } as unknown as SDKMessage,
      ]),
    );

    const events = [];
    for await (const event of claudeAdapter.run({ task: 'do the thing' }, ctx())) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        message: 'authentication_failed',
        recoverable: false,
      }),
    ]);
  });
});
