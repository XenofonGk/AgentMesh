/**
 * Invariant 2 — the proxy is never reachable from the host or the public internet.
 *
 * The original phrasing of this invariant ("binds to 127.0.0.1 only") was written
 * before anything else in the system needed to reach the proxy over a network. Taken
 * literally in a multi-container deployment, a socket bound to loopback is invisible
 * even to a sibling container on the same Docker network — including the runner
 * container the proxy exists to serve. That reading doesn't survive contact with real
 * container networking, so the control has moved from the bind address to the network
 * topology: the proxy listens on every interface *inside its own container* (like
 * `db`/`api`/`web` already do), and is never given a `ports:` entry in `compose.yaml` —
 * no host publication, at all, regardless of firewall or `0.0.0.0` binding. It sits on a
 * `internal: true` Docker network that has no route to the outside world, shared only
 * with the API (which issues run grants) and runner containers (which forward through
 * it). The proxy separately joins a second, normal network for its own real egress to
 * providers — that combination is what makes it reachable by exactly the two things
 * that should reach it, and nothing else. See `compose.yaml` and `SECURITY.md`.
 */
export const PROXY_BIND_HOST = '0.0.0.0' as const;

/** Configurable — always has been. */
export const PROXY_DEFAULT_PORT = 3002 as const;
