/**
 * The process every runner container actually runs. Reads the env the orchestrator set
 * (`config.ts`), picks the adapter named by `AGENTMESH_PROVIDER` (`registry.ts`), and
 * runs it via `run-once.ts` — see that module for the reporting contract.
 */
import { loadRunnerConfig } from './config.js';
import { resolveAdapter } from './registry.js';
import { runAttempt } from './run-once.js';

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  const adapter = resolveAdapter(config.AGENTMESH_PROVIDER);
  const succeeded = await runAttempt(config, adapter);
  process.exitCode = succeeded ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('runner crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
