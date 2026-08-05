/**
 * EVALUATE step of PLAN.md §6's improvement loop — "run old vs new on a held-out test
 * set (multiple samples)". Deliberately narrow: this module does not detect
 * underperforming skills (OBSERVE), draft a revision (PROPOSE), gate on human review
 * (GATE), or version anything (VERSION) — see PLAN.md §6's diagram. It only answers
 * "given a skill (or two), a test set, and a sample count, how did it do?"
 *
 * This module never starts a run itself — CLAUDE.md's invariants (vault, proxy,
 * container isolation) all live behind the orchestrator, and duplicating any part of
 * that path here would either violate one of them or drift from it. Instead it takes a
 * `RunExecutor` — a caller-supplied function that runs one (task, provider, skills)
 * case to completion and reports the outcome — so the *same* authenticated,
 * vaulted path a normal run takes is what every eval sample takes too. See
 * `packages/skills/src/eval-cli.ts` for the concrete executor that drives this against
 * a live AgentMesh API.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgentEvent, Usage } from '@agentmesh/core';
import type { Skill } from './schema.js';

/**
 * One held-out test case. `providers` is optional per-case — omit it to run the case
 * against every provider the harness was invoked with (`EvaluateSkillOptions.providers`
 * / `CompareSkillVersionsOptions.providers`); set it to restrict a specific case to a
 * subset (e.g. a case that only makes sense for a tool-using provider).
 */
export const EvalCaseSchema = z.object({
  task: z.string().min(1),
  providers: z.array(z.string().min(1)).min(1).optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const EvalTestSetSchema = z.object({
  cases: z.array(EvalCaseSchema).min(1),
});

/**
 * The test-set file format — deliberately minimal, per the task's "keep it minimal and
 * documented" instruction rather than inventing a DSL:
 *
 * ```yaml
 * cases:
 *   - task: "Add input validation to the signup form"
 *     providers: [claude, gemini]   # optional — omit to use the harness's default providers
 *   - task: "Fix the off-by-one in pagination"
 * ```
 *
 * The equivalent JSON (`{"cases": [...]}`) works identically — format is chosen by file
 * extension (`.yaml`/`.yml` vs `.json`), and content is validated with Zod, matching
 * every other external-input boundary in this repo (CLAUDE.md).
 *
 * "Split train/test" (PLAN.md §6) is a filesystem convention, not a feature this
 * function enforces: point it at whatever file holds your held-out cases, and keep
 * training/example cases in a separate file you never pass here.
 */
export async function loadTestSet(path: string): Promise<EvalCase[]> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  const testSet = EvalTestSetSchema.parse(parsed);
  return testSet.cases;
}

/** What a single sample run reports — the `done` event's outcome plus its `Usage`. */
/** Matches the `done` `AgentEvent`'s `outcome` field — see `packages/core/src/agent-event.ts`. */
export type EvalOutcome = Extract<AgentEvent, { type: 'done' }>['outcome'];

export interface EvalSampleResult {
  provider: string;
  task: string;
  outcome: EvalOutcome;
  usage: Usage | null;
}

/**
 * Runs one (task, provider, skills) case to completion and reports how it ended.
 * Implemented by a caller that actually starts a run through the real orchestrator/API
 * path (`eval-cli.ts`'s HTTP executor, or a test's fake) — this module never spawns a
 * sandbox itself. `attemptIndex` is 0-based within a case's sample set, passed through
 * only so an executor can label/log concurrent samples; the harness attaches no meaning
 * to it.
 */
export type RunExecutor = (args: {
  task: string;
  provider: string;
  skills: readonly Skill[];
  attemptIndex: number;
}) => Promise<EvalSampleResult>;

/** Aggregate stats for one provider, over every sample collected for it. */
export interface ProviderAggregate {
  provider: string;
  samples: number;
  successRate: number;
  /** `null` when no sample in this aggregate reported a usable (non-null) value. */
  meanCostUsd: number | null;
  meanLatencyMs: number | null;
}

export interface EvalReport {
  /** Total samples across every provider — `providers.length` aggregates, this many rows. */
  totalSamples: number;
  providers: ProviderAggregate[];
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, v) => sum + v, 0) / present.length;
}

/** Pure aggregation — no I/O, so this is what `eval.test.ts` exercises directly. */
export function aggregateResults(results: readonly EvalSampleResult[]): EvalReport {
  const byProvider = new Map<string, EvalSampleResult[]>();
  for (const result of results) {
    const bucket = byProvider.get(result.provider);
    if (bucket) bucket.push(result);
    else byProvider.set(result.provider, [result]);
  }

  const providers: ProviderAggregate[] = [...byProvider.entries()].map(
    ([provider, samples]) => ({
      provider,
      samples: samples.length,
      successRate:
        samples.filter((s) => s.outcome === 'succeeded').length / samples.length,
      meanCostUsd: mean(samples.map((s) => s.usage?.costUsd ?? null)),
      meanLatencyMs: mean(samples.map((s) => s.usage?.latencyMs ?? null)),
    }),
  );

  return { totalSamples: results.length, providers };
}

export interface EvaluateSkillOptions {
  skills: readonly Skill[];
  testSet: readonly EvalCase[];
  /** Default provider set for cases that don't specify their own `providers`. */
  providers: readonly string[];
  /** "Run each case ~3x and compare rates" (PLAN.md §6) — required, not defaulted. */
  sampleCount: number;
  executor: RunExecutor;
  /**
   * Samples run sequentially by default (safest against rate limits / cost surprises
   * for a first pass). Raise to run samples concurrently via `Promise.all` batching.
   */
  concurrency?: number;
}

function providersForCase(testCase: EvalCase, defaultProviders: readonly string[]): readonly string[] {
  return testCase.providers ?? defaultProviders;
}

/**
 * Runs every case in `testSet` `sampleCount` times per provider, with `skills`
 * attached, via the injected `executor` — then aggregates. This is the whole EVALUATE
 * step for a single skill (version).
 */
export async function evaluateSkill(options: EvaluateSkillOptions): Promise<EvalReport> {
  if (options.sampleCount < 1) {
    throw new Error('sampleCount must be at least 1');
  }
  const concurrency = options.concurrency ?? 1;

  const jobs: (() => Promise<EvalSampleResult>)[] = [];
  for (const testCase of options.testSet) {
    for (const provider of providersForCase(testCase, options.providers)) {
      for (let i = 0; i < options.sampleCount; i++) {
        jobs.push(() =>
          options.executor({
            task: testCase.task,
            provider,
            skills: options.skills,
            attemptIndex: i,
          }),
        );
      }
    }
  }

  const results: EvalSampleResult[] = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((job) => job()))));
  }

  return aggregateResults(results);
}

export interface CompareSkillVersionsOptions {
  /**
   * "Old vs new" per PLAN.md step 4 — since skills have no versioning concept yet
   * (VERSION is separate, out-of-scope work), this is just two skill sets: whatever two
   * directories/paths the caller loaded, nothing fancier.
   */
  baseline: readonly Skill[];
  candidate: readonly Skill[];
  testSet: readonly EvalCase[];
  providers: readonly string[];
  sampleCount: number;
  executor: RunExecutor;
  concurrency?: number;
}

export interface CompareSkillVersionsReport {
  baseline: EvalReport;
  candidate: EvalReport;
}

/** Runs the same held-out test set against two skill versions and reports both. */
export async function compareSkillVersions(
  options: CompareSkillVersionsOptions,
): Promise<CompareSkillVersionsReport> {
  const shared = {
    testSet: options.testSet,
    providers: options.providers,
    sampleCount: options.sampleCount,
    executor: options.executor,
    ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
  };
  const [baseline, candidate] = await Promise.all([
    evaluateSkill({ ...shared, skills: options.baseline }),
    evaluateSkill({ ...shared, skills: options.candidate }),
  ]);
  return { baseline, candidate };
}
