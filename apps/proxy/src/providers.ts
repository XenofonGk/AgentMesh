/**
 * The pinned provider registry — the other half of "the runner must not name the
 * upstream."
 *
 * A proxy that forwards to whatever host or path an inbound request specifies is a
 * credential-attached SSRF relay: a compromised runner points it at an attacker's host
 * and the proxy helpfully attaches a real API key. The key never entered the runner,
 * and it leaks anyway.
 *
 * So every piece of "where does this go" is a lookup against a table defined here, in
 * code the runner cannot influence — never read from the request's Host header, a query
 * param, or the request path beyond the fixed suffix this table names explicitly.
 */

export interface ProviderRoute {
  provider: string;
  /** Fixed origin. Never derived from the incoming request. */
  origin: string;
  /**
   * Exact allowed upstream paths — a set, not a prefix or a wildcard. Adding an
   * endpoint the SDK actually needs is a one-line change; it is not `*`.
   */
  paths: ReadonlySet<string>;
  /** The header the vault-held secret is injected under for this provider. */
  authHeader: string;
  /**
   * Prepended to the secret before it's written into `authHeader` — e.g. `'Bearer '`
   * for OpenAI-compatible APIs' `Authorization` header. Absent for providers (Claude,
   * Gemini) whose auth header wants the raw value with nothing in front of it. Still
   * fixed, code-defined, never derived from anything the runner sends — same
   * reasoning as every other field on this table.
   */
  authValuePrefix?: string;
  /**
   * `false` only for Ollama. Every other route needs the vault to hand back a secret
   * before this route's request can be forwarded; Ollama's `credentialSchema` is `null`
   * (`packages/core/src/adapter.ts`) because there genuinely is none. Absent/`true`
   * means "resolve a secret first," so `server.ts`'s `vault.useCredential` call stays
   * the default for every route that doesn't explicitly opt out here.
   */
  secretRequired?: boolean;
}

/**
 * Anthropic, Gemini, DeepSeek, and Grok — deliberately not generalized further than
 * these data points prove necessary. `/v1/messages` is the one endpoint the Claude
 * Agent SDK's Messages API calls. Gemini's path bakes in one fixed model
 * (`gemini-2.0-flash:generateContent`, not the streaming variant — see the adapter's
 * own doc comment for why) rather than a family of model paths — same reasoning as
 * Claude's single path: widen this when a second model or endpoint actually needs it,
 * not before. `x-goog-api-key` is Google's own documented header for the Generative
 * Language API, so the run token travels there the same way it travels in `x-api-key`
 * for Claude — see `packages/adapters/src/claude/adapter.ts`'s module doc for why the
 * run token has to occupy the real auth header at all. DeepSeek and Grok are both
 * OpenAI-compatible: `Authorization: Bearer <key>`, hence `authValuePrefix` on both.
 */
/** Default origin for the `ollama` route — a Docker Desktop / Linux host-gateway alias
 * (see compose.yaml's `extra_hosts` on the proxy service), not the public internet.
 * Overridable per-deployment via `buildProviderRoutes`'s `ollamaUrl` argument, itself
 * fed by `OLLAMA_URL` (`config.ts`) so an operator with Ollama on a different box (a
 * LAN GPU machine, say) doesn't have to run on the default. */
export const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434';

/**
 * Anthropic, Gemini, DeepSeek, Grok, and Ollama. `ollamaUrl` lets `main.ts` bake in the
 * operator's `OLLAMA_URL` without needing a mutable global — see `DEFAULT_OLLAMA_URL`.
 */
export function buildProviderRoutes(
  ollamaUrl: string = DEFAULT_OLLAMA_URL,
): readonly ProviderRoute[] {
  return [
    ...BASE_PROVIDER_ROUTES,
    {
      provider: 'ollama',
      origin: ollamaUrl,
      // Ollama's streaming chat endpoint — see the adapter's own doc comment for why
      // this is `/api/chat`, not `/api/generate`.
      paths: new Set(['/api/chat']),
      // Not actually used to inject anything (secretRequired: false), but the run
      // token still needs a header slot to travel in — see providers.ts's own header
      // doc and the adapter's module comment for why that's still true with no secret.
      authHeader: 'authorization',
      authValuePrefix: 'Bearer ',
      secretRequired: false,
    },
  ];
}

const BASE_PROVIDER_ROUTES: readonly ProviderRoute[] = [
  {
    provider: 'claude',
    origin: 'https://api.anthropic.com',
    paths: new Set(['/v1/messages']),
    authHeader: 'x-api-key',
  },
  {
    provider: 'gemini',
    origin: 'https://generativelanguage.googleapis.com',
    paths: new Set(['/v1beta/models/gemini-2.0-flash:generateContent']),
    authHeader: 'x-goog-api-key',
  },
  {
    provider: 'deepseek',
    origin: 'https://api.deepseek.com',
    paths: new Set(['/chat/completions']),
    authHeader: 'authorization',
    authValuePrefix: 'Bearer ',
  },
  {
    provider: 'grok',
    origin: 'https://api.x.ai',
    paths: new Set(['/v1/chat/completions']),
    authHeader: 'authorization',
    authValuePrefix: 'Bearer ',
  },
];

/**
 * The routing table every caller that doesn't need a custom `OLLAMA_URL` uses —
 * `buildProviderRoutes()` with the default Ollama origin baked in. `main.ts` calls
 * `buildProviderRoutes(config.OLLAMA_URL)` directly instead, for the real deployment.
 */
export const DEFAULT_PROVIDER_ROUTES: readonly ProviderRoute[] = buildProviderRoutes();

/**
 * Resolves a (provider, path) pair to a fixed route, or null if either the provider is
 * unknown or the path is not on that provider's allowlist. Both failures return the
 * same null — the caller maps that to a single "no such route" response, so a probe for
 * an unlisted path can't be used to enumerate which providers this instance knows about.
 */
export function resolveProviderRoute(
  provider: string,
  path: string,
  routes: readonly ProviderRoute[] = DEFAULT_PROVIDER_ROUTES,
): ProviderRoute | null {
  const route = routes.find((candidate) => candidate.provider === provider);
  if (route === undefined) return null;
  if (!route.paths.has(path)) return null;
  return route;
}
