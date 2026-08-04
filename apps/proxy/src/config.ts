import { z } from 'zod';
import { PROXY_DEFAULT_PORT } from './constants.js';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(PROXY_DEFAULT_PORT),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // The one Ollama-specific config value — not a secret, so it lives in the environment
  // like any other config, not the vault. See providers.ts's `DEFAULT_OLLAMA_URL` doc
  // for what the default points at and why.
  OLLAMA_URL: z.string().url().default('http://host.docker.internal:11434'),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Note what is deliberately absent: no `PROXY_HOST`. Unlike the API, the proxy's bind
 * address is not configuration — see `constants.ts` (invariant 2) — so there is no env
 * var for it to be misconfigured through in the first place.
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
