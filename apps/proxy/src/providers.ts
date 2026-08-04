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
}

/**
 * Anthropic only, deliberately. Generalizing the shape of "a provider route" from one
 * data point — before a second provider exists to prove the shape wrong — is exactly
 * the premature abstraction this codebase's conventions warn against. `/v1/messages` is
 * the one endpoint the Claude Agent SDK's Messages API calls; widen this table when a
 * second endpoint or a second provider actually needs it, not before.
 */
export const DEFAULT_PROVIDER_ROUTES: readonly ProviderRoute[] = [
  {
    provider: 'claude',
    origin: 'https://api.anthropic.com',
    paths: new Set(['/v1/messages']),
    authHeader: 'x-api-key',
  },
];

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
