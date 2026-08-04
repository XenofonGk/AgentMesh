/**
 * Provider adapters (claude | gemini | deepseek | grok | ollama).
 *
 * Only `claude` exists so far — Phase 2 (PLAN.md §5). See the `adapter-authoring` skill
 * before adding another; `ModelAdapter`/`AgentEvent` live in `packages/core`, never
 * redefined here.
 */
export { claudeAdapter, CLAUDE_CAPABILITIES } from './claude/adapter.js';
