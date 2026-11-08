/**
 * Provider adapters (claude | gemini | deepseek | grok | chatgpt | ollama).
 *
 * See the `adapter-authoring` skill before adding another; `ModelAdapter`/`AgentEvent`
 * live in `packages/core`, never redefined here. `chatgpt` is OpenAI's plain Chat
 * Completions API, non-agentic — a separate, agentic adapter for OpenAI's actual Codex
 * CLI (like `claudeAdapter` wraps the Claude Agent SDK subprocess) is a distinct,
 * larger follow-up, not this one.
 */
export { claudeAdapter, CLAUDE_CAPABILITIES } from './claude/adapter.js';
export { geminiAdapter, GEMINI_CAPABILITIES } from './gemini/adapter.js';
export { deepseekAdapter, DEEPSEEK_CAPABILITIES } from './deepseek/adapter.js';
export { grokAdapter, GROK_CAPABILITIES } from './grok/adapter.js';
export { chatgptAdapter, CHATGPT_CAPABILITIES } from './chatgpt/adapter.js';
export { ollamaAdapter, OLLAMA_CAPABILITIES } from './ollama/adapter.js';
