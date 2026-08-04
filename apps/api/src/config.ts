import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Bound inside the container; published to the host by Compose. */
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Exact origin allowed to call the API from a browser. No wildcard. */
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  /** Reachable only from the `internal` network — see compose.yaml and SECURITY.md. */
  PROXY_URL: z.string().url().default('http://proxy:3002'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parses process configuration at the boundary (CLAUDE.md → validate external input
 * with Zod). Throws on invalid config: a misconfigured process should fail to start,
 * not run in a half-defined state. The error never echoes values, only key names.
 */
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
