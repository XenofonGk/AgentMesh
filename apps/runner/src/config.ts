/**
 * Everything here is what the orchestrator set as this container's env (see
 * `apps/api/src/orchestrator/orchestrator.ts`). None of it is a credential — invariant
 * 6 — the run token is the one value here that looks like one and isn't; see
 * `packages/adapters/src/claude/adapter.ts`'s module doc for what it actually is.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  AGENTMESH_ATTEMPT_ID: z.string().uuid(),
  AGENTMESH_PROVIDER: z.string().min(1),
  AGENTMESH_TASK: z.string().min(1),
  AGENTMESH_RUN_TOKEN: z.string().min(1),
  AGENTMESH_PROXY_URL: z.string().url(),
  AGENTMESH_API_URL: z.string().url(),
  /** Where `DockerSandboxProvider` mounts the workspace — see docker-sandbox-provider.ts. */
  AGENTMESH_WORKSPACE_PATH: z.string().min(1).default('/workspace'),
});

export type RunnerConfig = z.infer<typeof EnvSchema>;

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid runner environment — ${keys}`);
  }
  return parsed.data;
}
