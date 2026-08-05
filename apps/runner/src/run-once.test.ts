/**
 * `fetch` is mocked (no real API), and the adapter is a hand-built fake — what's under
 * test is `runAttempt`'s own contract: every event gets reported, in order, with the
 * run token attached; a missing `done` gets synthesized; a missing adapter gets a
 * synthetic error + done instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ModelAdapter, RunInput } from '@agentmesh/core';
import type { Skill } from '@agentmesh/skills';
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

  describe('skill delivery — same artifact, different mechanism per PLAN.md §5', () => {
    const skill: Skill = {
      name: 'pdf-forms',
      description: 'Fill and flatten PDF forms.',
      license: undefined,
      allowedTools: undefined,
      body: 'Read the template, then fill the fields.',
      sourcePath: '/skills/pdf-forms/SKILL.md',
    };

    function recordingAdapter(agentic: boolean, seen: RunInput[]): ModelAdapter {
      return {
        id: 'fake',
        capabilities: { agentic, streaming: true, toolUse: agentic, maxContextTokens: 1 },
        credentialSchema: null,
        async *run(input: RunInput) {
          seen.push(input);
          yield done(agentic ? 'succeeded' : 'succeeded');
        },
      };
    }

    it('mounts SKILL.md into .claude/skills/ for an agentic adapter, without touching RunInput', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);
      const workspace = await mkdtemp(join(tmpdir(), 'agentmesh-runner-'));

      try {
        const seen: RunInput[] = [];
        await runAttempt(
          config({
            AGENTMESH_WORKSPACE_PATH: workspace,
            AGENTMESH_SKILLS: JSON.stringify([skill]),
          }),
          recordingAdapter(true, seen),
        );

        expect(seen).toHaveLength(1);
        expect(seen[0]?.systemPrompt).toBeUndefined();

        const mounted = await readFile(
          join(workspace, '.claude/skills/pdf-forms/SKILL.md'),
          'utf8',
        );
        expect(mounted).toContain('name: pdf-forms');
        expect(mounted).toContain('Read the template, then fill the fields.');
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });

    it('inlines the skill body into RunInput.systemPrompt for a non-agentic adapter', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const seen: RunInput[] = [];
      await runAttempt(
        config({
          AGENTMESH_PROVIDER: 'grok',
          AGENTMESH_SKILLS: JSON.stringify([skill]),
        }),
        recordingAdapter(false, seen),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]?.systemPrompt).toContain('pdf-forms');
      expect(seen[0]?.systemPrompt).toContain('Read the template, then fill the fields.');
    });

    it('leaves RunInput untouched when no skills are attached', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const seen: RunInput[] = [];
      await runAttempt(config({ AGENTMESH_PROVIDER: 'grok' }), recordingAdapter(false, seen));

      expect(seen).toHaveLength(1);
      expect(seen[0]?.systemPrompt).toBeUndefined();
    });
  });
});
