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
 * Notably absent: `authorization`, `x-api-key`, `cookie`, and `host` — all real values,
 * none of which belong on the outbound leg. `x-api-key` is also where a runner's run
 * token travels *inbound* (see server.ts: providers' own SDKs only know how to send a
 * credential in their normal auth header, so that's the slot the run token rides in
 * too) — it is read out of the raw request before this filter ever runs, and dropped
 * here same as any other auth-shaped header, because the value this function lets
 * through is never the run token or a credential, only what `vault.useCredential`
 * injects afterward.
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
