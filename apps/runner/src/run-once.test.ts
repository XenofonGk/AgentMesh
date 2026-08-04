/**
 * `fetch` is mocked (no real API), and the adapter is a hand-built fake — what's under
 * test is `runAttempt`'s own contract: every event gets reported, in order, with the
 * run token attached; a missing `done` gets synthesized; a missing adapter gets a
 * synthetic error + done instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ModelAdapter } from '@agentmesh/core';
import type { RunnerConfig } from './config.js';
import { runAttempt } from './run-once.js';

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    AGENTMESH_ATTEMPT_ID: 'a1111111-1111-1111-1111-111111111111',
    AGENTMESH_PROVIDER: 'claude',
    AGENTMESH_TASK: 'do the thing',
    AGENTMESH_RUN_TOKEN: 'run-token-abc',
    AGENTMESH_PROXY_URL: 'http://proxy:3002',
    AGENTMESH_API_URL: 'http://api:3001',
    AGENTMESH_WORKSPACE_PATH: '/workspace',
    ...overrides,
  };
}

function fakeAdapter(events: AgentEvent[]): ModelAdapter {
  return {
    id: 'fake',
    capabilities: { agentic: true, streaming: true, toolUse: true, maxContextTokens: 1 },
    credentialSchema: null,
    async *run() {
      for (const event of events) yield event;
    },
  };
}

function done(outcome: 'succeeded' | 'failed'): AgentEvent {
  return {
    attemptId: config().AGENTMESH_ATTEMPT_ID,
    provider: 'claude',
    timestamp: new Date().toISOString(),
    type: 'done',
    outcome,
    usage: null,
  };
}

describe('runAttempt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every event the adapter yields, with the run token attached', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [
      {
        attemptId: config().AGENTMESH_ATTEMPT_ID,
        provider: 'claude',
        timestamp: new Date().toISOString(),
        type: 'message_delta',
        role: 'assistant',
        text: 'hi',
      },
      done('succeeded'),
    ];

    const succeeded = await runAttempt(config(), fakeAdapter(events));

    expect(succeeded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `http://api:3001/internal/attempts/${config().AGENTMESH_ATTEMPT_ID}/events`,
    );
    expect((init as RequestInit).headers).toMatchObject({
      'x-agentmesh-run-token': 'run-token-abc',
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(events[0]);
  });

  it('returns false and synthesizes a done event when the adapter never emits one', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const events: AgentEvent[] = [
      {
        attemptId: config().AGENTMESH_ATTEMPT_ID,
        provider: 'claude',
        timestamp: new Date().toISOString(),
        type: 'message_delta',
        role: 'assistant',
        text: 'hi',
      },
    ];

    const succeeded = await runAttempt(config(), fakeAdapter(events));

    expect(succeeded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const synthesized = JSON.parse(
      fetchMock.mock.calls[1]![1].body as string,
    ) as AgentEvent;
    expect(synthesized).toMatchObject({ type: 'done', outcome: 'failed' });
  });

  it('reports a synthetic error + done and returns false when no adapter is registered', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const succeeded = await runAttempt(
      config({ AGENTMESH_PROVIDER: 'nonexistent' }),
      undefined,
    );

    expect(succeeded).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const errorEvent = JSON.parse(
      fetchMock.mock.calls[0]![1].body as string,
    ) as AgentEvent;
    expect(errorEvent).toMatchObject({ type: 'error', recoverable: false });
    const doneEvent = JSON.parse(
      fetchMock.mock.calls[1]![1].body as string,
    ) as AgentEvent;
    expect(doneEvent).toMatchObject({ type: 'done', outcome: 'failed' });
  });

  it('does not throw when reporting an event fails — logs and continues', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const succeeded = await runAttempt(config(), fakeAdapter([done('succeeded')]));

    expect(succeeded).toBe(true);
    expect(consoleError).toHaveBeenCalled();
  });

  it('reflects a failed outcome from the adapter itself', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const succeeded = await runAttempt(config(), fakeAdapter([done('failed')]));

    expect(succeeded).toBe(false);
  });
});
