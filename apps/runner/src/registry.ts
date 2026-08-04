/** Maps `AGENTMESH_PROVIDER` to the adapter that runs it — only `claude` exists yet. */
import { claudeAdapter } from '@agentmesh/adapters';
import type { ModelAdapter } from '@agentmesh/core';

const ADAPTERS: ReadonlyMap<string, ModelAdapter> = new Map([['claude', claudeAdapter]]);

export function resolveAdapter(provider: string): ModelAdapter | undefined {
  return ADAPTERS.get(provider);
}
