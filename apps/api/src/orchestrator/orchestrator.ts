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
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@agentmesh/db';
import { appendEvent, issueRunToken, revokeRunGrant, schema } from '@agentmesh/db';
import type { SandboxProvider, Usage } from '@agentmesh/core';
import type { Skill } from '@agentmesh/skills';
import { publish } from '../events/event-bus.js';

/** Attempt states `finishAttempt` is allowed to transition out of — see its own doc comment. */
const OPEN_STATUSES = ['pending', 'running'] as const;
type OpenStatus = (typeof OPEN_STATUSES)[number];
function isOpenStatus(status: string): status is OpenStatus {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

const { attempts, runs, chats } = schema;

/** Runner containers only ever see the internal network — never `default`. See compose.yaml. */
const RUNNER_NETWORK = 'internal';
/** Wall-clock cap on a single attempt, enforced by the sandbox's own timeout plus this destroy. */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * A run token outlives its attempt's own timeout by this much — the token must still
 * resolve while `finishAttempt` is busy tearing the attempt down, not expire out from
 * under it. Not itself overridable: it's a safety margin around whatever
 * `attemptTimeoutMs` a caller chose, not a second timeout to keep in sync by hand.
 */
const RUN_TOKEN_TTL_GRACE_MS = 60 * 1000;

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
  /**
   * Already-loaded, already-validated skills (`@agentmesh/skills`'s `loadSkillsFromDir`
   * — `routes.ts` is what resolves names to these) attached identically to every
   * attempt in the run. PLAN.md §5 Phase 4: "same artifact, different delivery" — this
   * class only serializes and hands them to each container via env; which delivery
   * mode a given provider actually uses is decided in the runner (`apps/runner`), which
   * is the one place that already knows the adapter's `capabilities.agentic`. Defaults
   * to none so most `startRun` callers and every existing test are unaffected.
   */
  skills?: readonly Skill[];
}

export interface StartRunResult {
  runId: string;
  attemptIds: readonly string[];
}

export class Orchestrator {
  /**
   * The wall-clock enforcement `packages/core/src/sandbox.ts` says lives here, not in
   * `SandboxProvider` — `DockerSandboxProvider` never reads `RunSpec.timeoutMs` itself.
   * Cleared by `finishAttempt` however an attempt ends, so a normal completion doesn't
   * leave a dangling timer around for the container's full remaining budget.
   */
  private readonly timeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Database,
    private readonly sandbox: SandboxProvider,
    /** Overridable so tests can exercise the timeout path in milliseconds, not minutes. */
    private readonly attemptTimeoutMs: number = DEFAULT_ATTEMPT_TIMEOUT_MS,
  ) {}

  /**
   * Creates the `Run` and fans it out to one `Attempt` per requested provider — the
   * parallel bake-off topology from CLAUDE.md. Each attempt is independent: one
   * container failing to start does not roll back the others, since PLAN.md requires
   * attempts stay fully independent.
   */
  async startRun(options: StartRunOptions): Promise<StartRunResult> {
    const skills = options.skills ?? [];
    const [run] = await this.db
      .insert(runs)
      .values({
        userId: options.userId,
        task: options.task,
        status: 'running',
        skillNames: skills.map((skill) => skill.name),
      })
      .returning({ id: runs.id });
    if (!run) {
      throw new Error('failed to create run');
    }

    // Serialized once, reused for every attempt: PLAN.md's "same artifact, different
    // delivery" means every attempt gets the identical skill set — which delivery mode
    // a given container actually uses is the runner's decision, not this class's (see
    // `StartRunOptions.skills`'s doc comment).
    const skillsEnv = skills.length > 0 ? JSON.stringify(skills) : undefined;

    const attemptIds: string[] = [];
    for (const attemptImage of options.attempts) {
      const attemptId = await this.startAttempt(
        { runId: run.id },
        options.userId,
        options.task,
        options.proxyUrl,
        options.apiUrl,
        attemptImage,
        skillsEnv,
      );
      attemptIds.push(attemptId);
    }

    return { runId: run.id, attemptIds };
  }

  /**
   * The chat half of attempt-spawning — same sandbox/token/timeout machinery as a
   * bake-off attempt (`startAttempt`), just keyed to a chat instead of a run. Public
   * because `chat/chat-service.ts` drives these one at a time, waiting for each to
   * finish before spawning the next (a relay, not a fan-out) — that sequencing isn't
   * this class's concern, only spawning and lifecycle are.
   */
  async startChatAttempt(
    chatId: string,
    userId: string,
    prompt: string,
    proxyUrl: string,
    apiUrl: string,
    attemptImage: AttemptImage,
  ): Promise<string> {
    return this.startAttempt(
      { chatId },
      userId,
      prompt,
      proxyUrl,
      apiUrl,
      attemptImage,
      undefined,
    );
  }

  private async startAttempt(
    target: { runId: string } | { chatId: string },
    userId: string,
    task: string,
    proxyUrl: string,
    apiUrl: string,
    attemptImage: AttemptImage,
    skillsEnv: string | undefined,
  ): Promise<string> {
    const [attempt] = await this.db
      .insert(attempts)
      .values({ ...target, provider: attemptImage.provider, status: 'pending' })
      .returning({ id: attempts.id });
    if (!attempt) {
      throw new Error('failed to create attempt');
    }

    try {
      const { token } = await issueRunToken(
        this.db,
        { attemptId: attempt.id, userId, provider: attemptImage.provider },
        this.attemptTimeoutMs + RUN_TOKEN_TTL_GRACE_MS,
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
          ...(skillsEnv !== undefined && { AGENTMESH_SKILLS: skillsEnv }),
        },
        networks: [RUNNER_NETWORK],
        resources: { cpus: 1, memoryMb: 2048 },
        timeoutMs: this.attemptTimeoutMs,
      });

      await this.db
        .update(attempts)
        .set({ status: 'running', containerId: sandbox.id, startedAt: new Date() })
        .where(eq(attempts.id, attempt.id));

      const timer = setTimeout(() => {
        void this.finishAttempt(attempt.id, {
          status: 'timed_out',
          errorMessage: 'attempt exceeded its wall-clock timeout',
        });
      }, this.attemptTimeoutMs);
      timer.unref();
      this.timeouts.set(attempt.id, timer);
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

  /**
   * Called on normal completion (the API's ingest route, on a `done` AgentEvent — see
   * `apps/api/src/events/routes.ts`), timeout (this class's own setTimeout, above), or
   * cancellation alike — always tears down both. Idempotent by design: a `done` event
   * and this attempt's own timeout can both fire for the same attempt (the event
   * arriving right as the timer was about to), and whichever loses the race must be a
   * no-op rather than clobbering the outcome the other one already recorded — an
   * attempt that finished 'succeeded' must never be overwritten to 'timed_out' by a
   * timer that simply hadn't been cleared yet.
   */
  async finishAttempt(
    attemptId: string,
    outcome: {
      status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
      errorMessage?: string;
      /** From the `done` AgentEvent, when there is one — absent on timeout/cancellation. */
      usage?: Usage | null;
    },
  ): Promise<void> {
    const timer = this.timeouts.get(attemptId);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(attemptId);
    }

    const usage = outcome.usage;
    const completedAt = new Date();

    // schema.ts's doc comment on `attempts`: latency has "no excuse" to stay null the
    // way cost/tokens can, since the container lifecycle always knows it, regardless of
    // whether the adapter itself reports one (none currently do). Read `startedAt`
    // before the update below so a container-lifecycle latency can fill in whenever the
    // adapter's own `usage.latencyMs` is null.
    const [existing] = await this.db
      .select({ startedAt: attempts.startedAt, provider: attempts.provider })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    const fallbackLatencyMs = existing?.startedAt
      ? completedAt.getTime() - existing.startedAt.getTime()
      : null;

    const [attempt] = await this.db
      .update(attempts)
      .set({
        status: outcome.status,
        errorMessage: outcome.errorMessage,
        completedAt,
        latencyMs: usage?.latencyMs ?? fallbackLatencyMs,
        ...(usage && {
          // Drizzle's `numeric` column wants a string in, and returns one out (see
          // schema.ts's own doc comment) — `costUsd` is the one field that needs the
          // conversion; the rest are already `integer` columns matching `Usage`'s shape.
          costUsd: usage.costUsd === null ? null : usage.costUsd.toString(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }),
      })
      .where(and(eq(attempts.id, attemptId), inArray(attempts.status, OPEN_STATUSES)))
      .returning({ containerId: attempts.containerId });

    // No row matched: some earlier call already finished this attempt. Everything below
    // (destroy, revoke) was already done by that call — nothing left to do here.
    if (!attempt) return;

    // `succeeded`/`failed` always arrive via the ingest route (`events/routes.ts`),
    // which already appended and published the runner's own real `done` event before
    // calling this method — publishing another here would duplicate it. `timed_out`
    // and `cancelled` are the two outcomes this class decides on its own, with no
    // runner left alive to ever report a `done` event itself — without this, a
    // browser watching the SSE stream never learns the attempt ended at all.
    if ((outcome.status === 'timed_out' || outcome.status === 'cancelled') && existing) {
      const doneEvent = {
        attemptId,
        provider: existing.provider,
        timestamp: completedAt.toISOString(),
        type: 'done' as const,
        outcome: outcome.status,
        usage: usage ?? null,
      };
      await appendEvent(this.db, doneEvent);
      publish(doneEvent);
    }

    if (attempt.containerId) {
      await this.sandbox.destroy(attempt.containerId);
    }
    await revokeRunGrant(this.db, attemptId);
  }

  private async ownsRun(runId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.userId, userId)));
    return row !== undefined;
  }

  private async ownsChat(chatId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
    return row !== undefined;
  }

  /**
   * Stops a still-open attempt: tears it down through the same `finishAttempt` a
   * normal completion or timeout uses (destroy + revoke), just with `status:
   * 'cancelled'`. Ownership is checked here, not by the caller — an attempt knows
   * only its own `runId`/`chatId`, so this is the one place that can resolve "whose
   * is this" for either kind without the route needing to know which.
   */
  async cancelAttempt(
    attemptId: string,
    userId: string,
  ): Promise<'not_found' | 'already_terminal' | 'cancelled'> {
    const [attempt] = await this.db
      .select({ status: attempts.status, runId: attempts.runId, chatId: attempts.chatId })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    if (!attempt) return 'not_found';

    const owns = attempt.runId
      ? await this.ownsRun(attempt.runId, userId)
      : attempt.chatId
        ? await this.ownsChat(attempt.chatId, userId)
        : false;
    if (!owns) return 'not_found';

    if (!isOpenStatus(attempt.status)) return 'already_terminal';

    await this.finishAttempt(attemptId, {
      status: 'cancelled',
      errorMessage: 'cancelled by user',
    });
    return 'cancelled';
  }

  /** Cancels every still-open attempt under a run or chat — the first step of
   *  deleting one, so a container doesn't keep running against rows about to
   *  disappear underneath it. */
  private async cancelOpenAttempts(target: { runId: string } | { chatId: string }): Promise<void> {
    const column = 'runId' in target ? attempts.runId : attempts.chatId;
    const value = 'runId' in target ? target.runId : target.chatId;
    const openRows = await this.db
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(column, value), inArray(attempts.status, OPEN_STATUSES)));
    for (const row of openRows) {
      await this.finishAttempt(row.id, {
        status: 'cancelled',
        errorMessage: 'parent run deleted',
      });
    }
  }

  /** `true` if a matching, owned run was deleted. Cascades to its attempts and their
   *  events (`schema.ts`'s `onDelete: 'cascade'`) — nothing to clean up by hand
   *  beyond the still-running containers `cancelOpenAttempts` stops first. */
  async deleteRun(runId: string, userId: string): Promise<boolean> {
    if (!(await this.ownsRun(runId, userId))) return false;
    await this.cancelOpenAttempts({ runId });
    await this.db.delete(runs).where(eq(runs.id, runId));
    return true;
  }

  /** Same shape as `deleteRun`, for a chat. */
  async deleteChat(chatId: string, userId: string): Promise<boolean> {
    if (!(await this.ownsChat(chatId, userId))) return false;
    await this.cancelOpenAttempts({ chatId });
    await this.db.delete(chats).where(eq(chats.id, chatId));
    return true;
  }
}
