/**
 * Provider adapters (claude | gemini | deepseek | grok | ollama).
 *
 * `claude`, `gemini`, and `deepseek` exist — Phase 2/3 (PLAN.md §5). See the
 * `adapter-authoring` skill before adding another; `ModelAdapter`/`AgentEvent` live in
 * `packages/core`, never redefined here.
 */
export { claudeAdapter, CLAUDE_CAPABILITIES } from './claude/adapter.js';
export { geminiAdapter, GEMINI_CAPABILITIES } from './gemini/adapter.js';
export { deepseekAdapter, DEEPSEEK_CAPABILITIES } from './deepseek/adapter.js';
