/**
 * Invariant 2 — the proxy binds to loopback only. It holds decrypted provider keys in
 * memory and injects them into outbound requests; anything that can reach it can spend
 * a user's credentials. Binding it to 0.0.0.0 turns a local component into an open
 * credential relay, so the address is a constant here rather than a configurable value.
 */
export const PROXY_BIND_HOST = '127.0.0.1' as const;

/** Default port. Configurable — unlike the host. */
export const PROXY_DEFAULT_PORT = 3002 as const;
