/** Maps `AGENTMESH_PROVIDER` to the adapter that runs it. */
import {
  claudeAdapter,
  deepseekAdapter,
  geminiAdapter,
  grokAdapter,
} from '@agentmesh/adapters';
import type { ModelAdapter } from '@agentmesh/core';

const ADAPTERS: ReadonlyMap<string, ModelAdapter> = new Map([
  ['claude', claudeAdapter],
  ['gemini', geminiAdapter],
  ['deepseek', deepseekAdapter],
  ['grok', grokAdapter],
]);

export function resolveAdapter(provider: string): ModelAdapter | undefined {
  return ADAPTERS.get(provider);
}
