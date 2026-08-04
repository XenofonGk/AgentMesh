/**
 * The normalized event shape every adapter's `run()` yields — PLAN.md §3. Defined once,
 * here, per CLAUDE.md's "`AgentEvent` is defined once, in `packages/core`": the API, the
 * DB, and the browser all speak this type and nothing provider-specific. An adapter that
 * leaks a raw provider payload past `run()` has broken the one property that makes a
 * four-way bake-off comparable at all.
 *
 * Every variant carries `provider` — the *only* way a consumer learns which provider
 * produced an event — and `attemptId`, so events from a parallel bake-off's N attempts
 * can be told apart without threading a second correlation id everywhere.
 */

interface AgentEventBase {
  attemptId: string;
  provider: string;
  /** ISO 8601. Set by the adapter at emission time, not the eventual DB insert time. */
  timestamp: string;
}

export type AgentEvent =
  | (AgentEventBase & {
      type: 'message_delta';
      role: 'assistant';
      /** A chunk, not the whole message — CLAUDE.md → adapter-authoring rule 4. */
      text: string;
    })
  | (AgentEventBase & {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      /**
       * Normalized to a complete block regardless of whether the provider streamed it
       * as deltas — see adapter-authoring's "Common traps". Adapters buffer internally.
       */
      input: unknown;
    })
  | (AgentEventBase & {
      type: 'tool_result';
      toolCallId: string;
      output: unknown;
      isError: boolean;
    })
  | (AgentEventBase & {
      type: 'file_edit';
      path: string;
      /** Unified diff. What the diff-review UI (Phase 3) renders directly. */
      diff: string;
    })
  | (AgentEventBase & {
      type: 'thinking';
      text: string;
    })
  | (AgentEventBase & {
      type: 'error';
      message: string;
      /** False for a stream-ending failure; true for a transient hiccup mid-run. */
      recoverable: boolean;
    })
  | (AgentEventBase & {
      type: 'done';
      outcome: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
      usage: Usage | null;
    });

/**
 * Every attempt records cost, latency, tokens, and outcome — CLAUDE.md, non-optional.
 * Individual fields are still nullable: token accounting is inconsistent across
 * providers and sometimes absent entirely, and a fabricated number is worse than a gap
 * (adapter-authoring's "Common traps" on `estimateCost`).
 */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}
