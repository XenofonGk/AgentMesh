import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateResults,
  compareSkillVersions,
  evaluateSkill,
  loadTestSet,
  type EvalSampleResult,
  type RunExecutor,
} from './eval.js';
import type { Skill } from './schema.js';

const skill: Skill = {
  name: 'pdf-forms',
  description: 'Fill and flatten PDF forms.',
  license: undefined,
  allowedTools: undefined,
  body: 'Do the thing.',
  sourcePath: '/skills/pdf-forms/SKILL.md',
};

const candidateSkill: Skill = { ...skill, body: 'Do the thing, better.' };

describe('aggregateResults', () => {
  it('computes success rate, mean cost, and mean latency per provider', () => {
    const results: EvalSampleResult[] = [
      { provider: 'claude', task: 't1', outcome: 'succeeded', usage: { costUsd: 0.1, latencyMs: 1000, inputTokens: 10, outputTokens: 20 } },
      { provider: 'claude', task: 't2', outcome: 'failed', usage: { costUsd: 0.3, latencyMs: 2000, inputTokens: 10, outputTokens: 20 } },
      { provider: 'gemini', task: 't1', outcome: 'succeeded', usage: { costUsd: 0.05, latencyMs: 500, inputTokens: 5, outputTokens: 10 } },
    ];

    const report = aggregateResults(results);

    expect(report.totalSamples).toBe(3);
    const claude = report.providers.find((p) => p.provider === 'claude');
    expect(claude?.samples).toBe(2);
    expect(claude?.successRate).toBeCloseTo(0.5);
    expect(claude?.meanCostUsd).toBeCloseTo(0.2);
    expect(claude?.meanLatencyMs).toBeCloseTo(1500);

    const gemini = report.providers.find((p) => p.provider === 'gemini');
    expect(gemini?.samples).toBe(1);
    expect(gemini?.successRate).toBe(1);
  });

  it('treats a null usage as absent from the mean rather than as zero', () => {
    const results: EvalSampleResult[] = [
      { provider: 'claude', task: 't1', outcome: 'succeeded', usage: { costUsd: 0.2, latencyMs: 1000, inputTokens: 1, outputTokens: 1 } },
      { provider: 'claude', task: 't2', outcome: 'succeeded', usage: null },
    ];

    const report = aggregateResults(results);
    const claude = report.providers[0]!;
    expect(claude.meanCostUsd).toBeCloseTo(0.2); // averaged over 1 sample, not 2
    expect(claude.successRate).toBe(1);
  });

  it('reports null means when every sample lacks usage', () => {
    const results: EvalSampleResult[] = [
      { provider: 'claude', task: 't1', outcome: 'succeeded', usage: null },
    ];
    const report = aggregateResults(results);
    expect(report.providers[0]?.meanCostUsd).toBeNull();
    expect(report.providers[0]?.meanLatencyMs).toBeNull();
  });
});

/** A fake `RunExecutor` recording every call — mirrors `FakeSandboxProvider`'s style. */
function fakeExecutor(outcomeFor: (provider: string) => EvalSampleResult['outcome']): {
  executor: RunExecutor;
  calls: { task: string; provider: string; skillNames: string[]; attemptIndex: number }[];
} {
  const calls: { task: string; provider: string; skillNames: string[]; attemptIndex: number }[] = [];
  const executor: RunExecutor = ({ task, provider, skills, attemptIndex }) => {
    calls.push({ task, provider, skillNames: skills.map((s) => s.name), attemptIndex });
    return Promise.resolve({
      provider,
      task,
      outcome: outcomeFor(provider),
      usage: { costUsd: 0.01, latencyMs: 100, inputTokens: 1, outputTokens: 1 },
    });
  };
  return { executor, calls };
}

describe('evaluateSkill', () => {
  it('runs each case sampleCount times per provider and aggregates', async () => {
    const { executor, calls } = fakeExecutor(() => 'succeeded');

    const report = await evaluateSkill({
      skills: [skill],
      testSet: [{ task: 'do X' }, { task: 'do Y' }],
      providers: ['claude', 'gemini'],
      sampleCount: 3,
      executor,
    });

    // 2 cases * 2 providers * 3 samples
    expect(calls).toHaveLength(12);
    expect(report.totalSamples).toBe(12);
    expect(report.providers.map((p) => p.provider).sort()).toEqual(['claude', 'gemini']);
    for (const p of report.providers) {
      expect(p.samples).toBe(6);
      expect(p.successRate).toBe(1);
    }
    expect(calls.every((c) => c.skillNames.includes('pdf-forms'))).toBe(true);
  });

  it('restricts a case to its own providers when specified, ignoring the default set', async () => {
    const { executor, calls } = fakeExecutor(() => 'succeeded');

    await evaluateSkill({
      skills: [skill],
      testSet: [{ task: 'claude-only', providers: ['claude'] }],
      providers: ['claude', 'gemini'],
      sampleCount: 1,
      executor,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('claude');
  });

  it('rejects a sampleCount below 1', async () => {
    const { executor } = fakeExecutor(() => 'succeeded');
    await expect(
      evaluateSkill({
        skills: [skill],
        testSet: [{ task: 'x' }],
        providers: ['claude'],
        sampleCount: 0,
        executor,
      }),
    ).rejects.toThrow(/sampleCount/);
  });
});

describe('compareSkillVersions', () => {
  it('runs the same test set against two skill sets and reports both', async () => {
    const { executor } = fakeExecutor(() => 'succeeded');

    const result = await compareSkillVersions({
      baseline: [skill],
      candidate: [candidateSkill],
      testSet: [{ task: 'do X' }],
      providers: ['claude'],
      sampleCount: 2,
      executor,
    });

    expect(result.baseline.totalSamples).toBe(2);
    expect(result.candidate.totalSamples).toBe(2);
  });

  it('lets baseline and candidate differ in observed success rate', async () => {
    let call = 0;
    const executor: RunExecutor = ({ task, provider, skills }) => {
      call++;
      const usingCandidate = skills.some((s) => s.body.includes('better'));
      return Promise.resolve({
        provider,
        task,
        outcome: usingCandidate ? 'succeeded' : 'failed',
        usage: null,
      });
    };
    void call;

    const result = await compareSkillVersions({
      baseline: [skill],
      candidate: [candidateSkill],
      testSet: [{ task: 'do X' }],
      providers: ['claude'],
      sampleCount: 1,
      executor,
    });

    expect(result.baseline.providers[0]?.successRate).toBe(0);
    expect(result.candidate.providers[0]?.successRate).toBe(1);
  });
});

describe('loadTestSet', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentmesh-eval-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a YAML test set', async () => {
    const path = join(dir, 'held-out.yaml');
    await writeFile(
      path,
      'cases:\n  - task: "Add input validation"\n    providers: [claude, gemini]\n  - task: "Fix pagination bug"\n',
      'utf8',
    );

    const cases = await loadTestSet(path);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({ task: 'Add input validation', providers: ['claude', 'gemini'] });
    expect(cases[1]?.providers).toBeUndefined();
  });

  it('parses a JSON test set identically', async () => {
    const path = join(dir, 'held-out.json');
    await writeFile(
      path,
      JSON.stringify({ cases: [{ task: 'do X' }] }),
      'utf8',
    );

    const cases = await loadTestSet(path);
    expect(cases).toEqual([{ task: 'do X' }]);
  });

  it('rejects a test set with no cases', async () => {
    const path = join(dir, 'empty.json');
    await writeFile(path, JSON.stringify({ cases: [] }), 'utf8');
    await expect(loadTestSet(path)).rejects.toThrow();
  });
});
