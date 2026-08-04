/**
 * Credential-injecting egress proxy.
 *
 * Invariant 2 — the proxy is never reachable from the host or the public internet
 * (`constants.ts`). It holds decrypted provider keys in memory for the life of a
 * single request and injects them into outbound requests; anything that can reach it
 * can spend a user's credentials.
 */

export { PROXY_BIND_HOST, PROXY_DEFAULT_PORT } from './constants.js';
export { buildProxyServer } from './server.js';
export type { BuildProxyOptions, ProxyApp } from './server.js';
export { DEFAULT_PROVIDER_ROUTES, resolveProviderRoute } from './providers.js';
export type { ProviderRoute } from './providers.js';
export { filterInboundHeaders, RUN_TOKEN_HEADER } from './headers.js';
