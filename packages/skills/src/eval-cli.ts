/**
 * The thin CLI wrapper for `eval.ts` — drives the harness against a *live* AgentMesh
 * API, so every sample goes through the exact same authenticated, vaulted run path a
 * normal `POST /runs` would (CLAUDE.md's invariants around the vault/proxy/container
 * isolation are untouched — this module only ever calls the public HTTP API, never the
 * orchestrator, vault, or sandbox provider directly).
 *
 * Not wired into any app's build — invoke with `tsx` (already a devDependency across
 * this repo) pointed at a running API instance, e.g.:
 *
 * ```
 * AGENTMESH_API_URL=http://localhost:3001 \
 * AGENTMESH_SESSION_COOKIE=agentmesh_session=... \
 *   tsx packages/skills/src/eval-cli.ts \
 *     --skills ./skills/my-skill \
 *     --test-set ./skills/my-skill/eval/held-out.yaml \
 *     --providers claude,gemini \
 *     --samples 3
 * ```
 *
 * For an old-vs-new comparison, pass `--candidate-skills` alongside `--skills` (treated
 * as the baseline) — both are run against the same test set and both reports print.
 */
import { loadSkillsFromDir } from './loader.js';
import {
  compareSkillVersions,
  evaluateSkill,
  loadTestSet,
  type EvalReport,
  type EvalSampleResult,
  type RunExecutor,
} from './eval.js';

interface CliArgs {
  skillsDir: string;
  candidateSkillsDir: string | undefined;
  testSetPath: string;
  providers: string[];
  samples: number;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag?.startsWith('--') && value !== undefined) {
      flags.set(flag.slice(2), value);
    }
  }

  const skillsDir = flags.get('skills');
  const testSetPath = flags.get('test-set');
  const providersRaw = flags.get('providers');
  if (!skillsDir || !testSetPath || !providersRaw) {
    throw new Error(
      'usage: eval-cli --skills <dir> --test-set <path> --providers <a,b,c> [--samples N] [--candidate-skills <dir>] [--concurrency N]',
    );
  }

  return {
    skillsDir,
    candidateSkillsDir: flags.get('candidate-skills'),
    testSetPath,
    providers: providersRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    samples: Number(flags.get('samples') ?? '3'),
    concurrency: Number(flags.get('concurrency') ?? '1'),
  };
}

/**
 * A `RunExecutor` backed by the real HTTP API: starts a run with a single provider and
 * the given skills attached, then polls `GET /runs/:id` until the (sole) attempt leaves
 * `pending`/`running`. Polling, not SSE, on purpose — this is an offline batch harness,
 * not a live UI, and a poll loop needs no long-lived connection management.
 */
function createHttpExecutor(apiUrl: string, sessionCookie: string): RunExecutor {
  return async ({ task, provider, skills }): Promise<EvalSampleResult> => {
    const startRes = await fetch(`${apiUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({
        task,
        providers: [provider],
        skills: skills.map((s) => s.name),
      }),
    });
    if (!startRes.ok) {
      throw new Error(
        `failed to start run: ${startRes.status.toString()} ${await startRes.text()}`,
      );
    }
    const started = (await startRes.json()) as { runId: string };

    const POLL_INTERVAL_MS = 2000;
    for (;;) {
      const runRes = await fetch(`${apiUrl}/runs/${started.runId}`, {
        headers: { cookie: sessionCookie },
      });
      if (!runRes.ok) {
        throw new Error(`failed to poll run: ${runRes.status.toString()}`);
      }
      const run = (await runRes.json()) as {
        attempts: {
          status: string;
          outcome: EvalSampleResult['outcome'] | null;
          costUsd: number | null;
          latencyMs: number | null;
          inputTokens: number | null;
          outputTokens: number | null;
        }[];
      };
      const attempt = run.attempts[0];
      if (attempt && !['pending', 'running'].includes(attempt.status)) {
        return {
          provider,
          task,
          outcome: attempt.outcome ?? (attempt.status as EvalSampleResult['outcome']),
          usage:
            attempt.costUsd === null &&
            attempt.latencyMs === null &&
            attempt.inputTokens === null &&
            attempt.outputTokens === null
              ? null
              : {
                  costUsd: attempt.costUsd,
                  latencyMs: attempt.latencyMs,
                  inputTokens: attempt.inputTokens,
                  outputTokens: attempt.outputTokens,
                },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };
}

function printReport(label: string, report: EvalReport): void {
  console.error(`\n${label} (${report.totalSamples.toString()} samples)`);
  for (const p of report.providers) {
    console.error(
      `  ${p.provider}: success=${(p.successRate * 100).toFixed(1)}% ` +
        `meanCost=${p.meanCostUsd === null ? 'n/a' : `$${p.meanCostUsd.toFixed(4)}`} ` +
        `meanLatency=${p.meanLatencyMs === null ? 'n/a' : `${p.meanLatencyMs.toFixed(0)}ms`} ` +
        `(n=${p.samples.toString()})`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = process.env['AGENTMESH_API_URL'];
  const sessionCookie = process.env['AGENTMESH_SESSION_COOKIE'];
  if (!apiUrl || !sessionCookie) {
    throw new Error('set AGENTMESH_API_URL and AGENTMESH_SESSION_COOKIE');
  }

  const testSet = await loadTestSet(args.testSetPath);
  const executor = createHttpExecutor(apiUrl, sessionCookie);

  const baselineLoaded = await loadSkillsFromDir(args.skillsDir);
  if (!baselineLoaded.ok) {
    throw new Error(`failed to load --skills: ${baselineLoaded.error.kind}`);
  }

  if (args.candidateSkillsDir) {
    const candidateLoaded = await loadSkillsFromDir(args.candidateSkillsDir);
    if (!candidateLoaded.ok) {
      throw new Error(`failed to load --candidate-skills: ${candidateLoaded.error.kind}`);
    }
    const { baseline, candidate } = await compareSkillVersions({
      baseline: baselineLoaded.value,
      candidate: candidateLoaded.value,
      testSet,
      providers: args.providers,
      sampleCount: args.samples,
      executor,
      concurrency: args.concurrency,
    });
    printReport('baseline', baseline);
    printReport('candidate', candidate);
    return;
  }

  const report = await evaluateSkill({
    skills: baselineLoaded.value,
    testSet,
    providers: args.providers,
    sampleCount: args.samples,
    executor,
    concurrency: args.concurrency,
  });
  printReport('skills', report);
}

// Only run when invoked directly (`tsx eval-cli.ts ...`), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
