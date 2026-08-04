/**
 * Ties together everything the previous passes built: a `runs`/`attempts` row per
 * attempt, a run-token issued through `@agentmesh/db` (never a credential), and a
 * sandbox started through whatever `SandboxProvider` was injected — real Docker in
 * production, `FakeSandboxProvider` in tests.
 *
 * What this module deliberately does not do: talk to a provider adapter, or decide
 * what image/command a provider needs. That's the adapter-authoring layer's job (see
 * CLAUDE.md's "Adding a provider adapter"), not the orchestrator's — this module only
 * owns the run lifecycle, not per-provider behavior.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import { issueRunToken, revokeRunGrant, schema } from '@agentmesh/db';
import type { SandboxProvider } from '@agentmesh/core';

const { attempts, runs } = schema;

/** Runner containers only ever see the internal network — never `default`. See compose.yaml. */
const RUNNER_NETWORK = 'internal';
/** Wall-clock cap on a single attempt, enforced by the sandbox's own timeout plus this destroy. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
/** Run tokens are scoped to one attempt's lifetime, not reused across retries. */
const RUN_TOKEN_TTL_MS = DEFAULT_ATTEMPT_TIMEOUT_MS + 60 * 1000;

export interface AttemptImage {
  provider: string;
  image: string;
  command: readonly string[];
}

export interface StartRunOptions {
  userId: string;
  task: string;
  attempts: readonly AttemptImage[];
  proxyUrl: string;
  /** Where the runner's entrypoint reports `AgentEvent`s — see `apps/api/src/events/routes.ts`. */
  apiUrl: string;
}

export interface StartRunResult {
  runId: string;
  attemptIds: readonly string[];
}

export class Orchestrator {
  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxProvider,
  ) {}

  /**
   * Creates the `Run` and fans it out to one `Attempt` per requested provider — the
   * parallel bake-off topology from CLAUDE.md. Each attempt is independent: one
   * container failing to start does not roll back the others, since PLAN.md requires
   * attempts stay fully independent.
   */
  async startRun(options: StartRunOptions): Promise<StartRunResult> {
    const [run] = await this.db
      .insert(runs)
      .values({ userId: options.userId, task: options.task, status: 'running' })
      .returning({ id: runs.id });
    if (!run) {
      throw new Error('failed to create run');
    }

    const attemptIds: string[] = [];
    for (const attemptImage of options.attempts) {
      const attemptId = await this.startAttempt(
        run.id,
        options.userId,
        options.task,
        options.proxyUrl,
        options.apiUrl,
        attemptImage,
      );
      attemptIds.push(attemptId);
    }

    return { runId: run.id, attemptIds };
  }

  private async startAttempt(
    runId: string,
    userId: string,
    task: string,
    proxyUrl: string,
    apiUrl: string,
    attemptImage: AttemptImage,
  ): Promise<string> {
    const [attempt] = await this.db
      .insert(attempts)
      .values({ runId, provider: attemptImage.provider, status: 'pending' })
      .returning({ id: attempts.id });
    if (!attempt) {
      throw new Error('failed to create attempt');
    }

    try {
      const { token } = await issueRunToken(
        this.db,
        { attemptId: attempt.id, userId, provider: attemptImage.provider },
        RUN_TOKEN_TTL_MS,
      );

      const sandbox = await this.sandbox.create({
        id: attempt.id,
        image: attemptImage.image,
        command: attemptImage.command,
        env: {
          AGENTMESH_RUN_TOKEN: token,
          AGENTMESH_PROXY_URL: proxyUrl,
          AGENTMESH_API_URL: apiUrl,
          AGENTMESH_ATTEMPT_ID: attempt.id,
          AGENTMESH_PROVIDER: attemptImage.provider,
          AGENTMESH_TASK: task,
        },
        networks: [RUNNER_NETWORK],
        resources: { cpus: 1, memoryMb: 2048 },
        timeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
      });

      await this.db
        .update(attempts)
        .set({ status: 'running', containerId: sandbox.id, startedAt: new Date() })
        .where(eq(attempts.id, attempt.id));
    } catch (error) {
      await this.db
        .update(attempts)
        .set({
          status: 'failed',
          errorMessage:
            error instanceof Error ? error.message : 'sandbox creation failed',
          completedAt: new Date(),
        })
        .where(eq(attempts.id, attempt.id));
      await revokeRunGrant(this.db, attempt.id);
    }

    return attempt.id;
  }

  /** Called on normal completion, timeout, or cancellation alike — always tears down both. */
  async finishAttempt(
    attemptId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
      errorMessage?: string;
    },
  ): Promise<void> {
    const [attempt] = await this.db
      .select({ containerId: attempts.containerId })
      .from(attempts)
      .where(eq(attempts.id, attemptId));

    if (attempt?.containerId) {
      await this.sandbox.destroy(attempt.containerId);
    }
    await revokeRunGrant(this.db, attemptId);

    await this.db
      .update(attempts)
      .set({
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        completedAt: new Date(),
      })
      .where(eq(attempts.id, attemptId));
  }
}
