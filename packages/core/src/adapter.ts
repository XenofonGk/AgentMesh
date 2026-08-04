/**
 * The one interface every provider implements — PLAN.md §3, "get it right and adding a
 * provider is a 100-line file." Use the `adapter-authoring` skill when implementing one;
 * do not freehand it.
 */
import type { ZodTypeAny } from 'zod';
import type { AgentEvent, Usage } from './agent-event.js';

export interface RunInput {
  task: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

/**
 * How, not what. An adapter never receives a credential — invariant 6 and
 * adapter-authoring rule 2. It gets a proxy URL and an opaque run token, exactly what
 * the orchestrator already hands a sandboxed runner (see
 * `apps/api/src/orchestrator/orchestrator.ts`'s `AGENTMESH_PROXY_URL` /
 * `AGENTMESH_RUN_TOKEN` env vars) — `RunContext` is that same pair, typed for the
 * adapter that runs inside the sandbox rather than the orchestrator that spawned it.
 */
export interface RunContext {
  attemptId: string;
  proxyUrl: string;
  runToken: string;
  workspacePath: string;
  signal?: AbortSignal;
}

export interface AdapterCapabilities {
  /** Can it edit files / run tools autonomously, or is it a plain chat completion? */
  agentic: boolean;
  streaming: boolean;
  toolUse: boolean;
  maxContextTokens: number;
}

export interface ModelAdapter {
  id: string;
  capabilities: AdapterCapabilities;
  /** `null` when no key is needed at all (Ollama) — not an empty schema, a real null. */
  credentialSchema: ZodTypeAny | null;
  run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent>;
  /** `null` is an acceptable, honest answer — see `Usage`'s doc comment. */
  estimateCost?(usage: Usage): number | null;
}
