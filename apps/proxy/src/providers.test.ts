import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_ROUTES, resolveProviderRoute } from './providers.js';

describe('resolveProviderRoute', () => {
  it('resolves a known provider and path', () => {
    const route = resolveProviderRoute('claude', '/v1/messages');
    expect(route?.origin).toBe('https://api.anthropic.com');
    expect(route?.authHeader).toBe('x-api-key');
  });

  it('rejects an unknown provider', () => {
    expect(resolveProviderRoute('not-a-real-provider', '/v1/messages')).toBeNull();
  });

  /** The core SSRF guard: a path outside the allowlist is refused, not proxied blindly. */
  it("rejects a path not on the provider's allowlist", () => {
    expect(resolveProviderRoute('claude', '/v1/evil-endpoint')).toBeNull();
    expect(resolveProviderRoute('claude', '/')).toBeNull();
    expect(resolveProviderRoute('claude', '/v1/messages/../../admin')).toBeNull();
  });

  it('does not prefix-match — only exact paths are allowed', () => {
    expect(resolveProviderRoute('claude', '/v1/messages/extra')).toBeNull();
    expect(resolveProviderRoute('claude', '/v1/messagesx')).toBeNull();
  });

  it('accepts an injected routing table, for tests that need a fake upstream', () => {
    const testRoutes = [
      {
        provider: 'claude',
        origin: 'http://127.0.0.1:9999',
        paths: new Set(['/v1/messages']),
        authHeader: 'x-api-key',
      },
    ];
    expect(resolveProviderRoute('claude', '/v1/messages', testRoutes)?.origin).toBe(
      'http://127.0.0.1:9999',
    );
  });

  it('ships with exactly the routes documented, so an addition here is deliberate', () => {
    expect(DEFAULT_PROVIDER_ROUTES).toHaveLength(1);
    expect(DEFAULT_PROVIDER_ROUTES[0]!.provider).toBe('claude');
  });
});
