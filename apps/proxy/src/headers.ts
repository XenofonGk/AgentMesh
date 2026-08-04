/**
 * Inbound header filtering — an allowlist, not a blocklist.
 *
 * The runner's own request headers are never forwarded verbatim. If they were, a
 * runner could send its own `x-api-key` or `authorization` and either spoof a value the
 * upstream might accept from this proxy's IP, or simply shadow/confuse the header this
 * proxy is about to inject. An allowlist makes that structurally impossible: nothing not
 * named here reaches the outbound request, so there is no such thing as "which header
 * wins" — the runner's copy was never forwarded in the first place.
 */

/**
 * Everything the Anthropic Messages API needs from the caller side, and nothing else.
 * Notably absent: `authorization`, `x-api-key`, `cookie`, `host`, and the run-token
 * header itself — all real values, none of which belong on the outbound leg.
 */
const ALLOWED_INBOUND_HEADERS = new Set([
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
]);

export function filterInboundHeaders(
  headers: Record<string, unknown>,
): Record<string, string> {
  const outbound: Record<string, string> = {};
  for (const name of ALLOWED_INBOUND_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') outbound[name] = value;
  }
  return outbound;
}

/** The header a runner presents its run token in. Never in `ALLOWED_INBOUND_HEADERS`. */
export const RUN_TOKEN_HEADER = 'x-agentmesh-run-token';
