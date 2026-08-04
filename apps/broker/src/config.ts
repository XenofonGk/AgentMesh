import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Deliberately not `127.0.0.1`: the API is a separate container and loopback does
   * not cross container boundaries (the same lesson `apps/proxy/src/constants.ts`
   * documents). Reachability is enforced by the `internal` Docker network having no
   * `ports:` entry in compose.yaml for this service, never by the bind address.
   */
  BROKER_HOST: z.string().min(1).default('0.0.0.0'),
  BROKER_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  /** Host-side root the broker creates one per-attempt workspace directory under. */
  WORKSPACE_ROOT: z.string().min(1).default('/var/lib/agentmesh/workspaces'),
  /** The only Docker network a sandbox is ever attached to. See compose.yaml. */
  RUNNER_NETWORK: z.string().min(1).default('internal'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${keys}`);
  }
  return parsed.data;
}
