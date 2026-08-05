import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_ROUTES,
  buildProviderRoutes,
  resolveProviderRoute,
} from './providers.js';

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

  it('resolves gemini on its own fixed model path', () => {
    const route = resolveProviderRoute(
      'gemini',
      '/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect(route?.origin).toBe('https://generativelanguage.googleapis.com');
    expect(route?.authHeader).toBe('x-goog-api-key');
  });

  it('resolves deepseek with a Bearer auth value prefix', () => {
    const route = resolveProviderRoute('deepseek', '/chat/completions');
    expect(route?.origin).toBe('https://api.deepseek.com');
    expect(route?.authHeader).toBe('authorization');
    expect(route?.authValuePrefix).toBe('Bearer ');
  });

  it('resolves grok with a Bearer auth value prefix', () => {
    const route = resolveProviderRoute('grok', '/v1/chat/completions');
    expect(route?.origin).toBe('https://api.x.ai');
    expect(route?.authHeader).toBe('authorization');
    expect(route?.authValuePrefix).toBe('Bearer ');
  });

  it('resolves ollama with secretRequired false and the configured default origin', () => {
    const route = resolveProviderRoute('ollama', '/api/chat');
    expect(route?.origin).toBe('http://host.docker.internal:11434');
    expect(route?.secretRequired).toBe(false);
  });

  it('ships with exactly the routes documented, so an addition here is deliberate', () => {
    expect(DEFAULT_PROVIDER_ROUTES).toHaveLength(5);
    expect(DEFAULT_PROVIDER_ROUTES.map((route) => route.provider)).toEqual([
      'claude',
      'gemini',
      'deepseek',
      'grok',
      'ollama',
    ]);
  });

  it('buildProviderRoutes lets an operator override the ollama origin', () => {
    const routes = buildProviderRoutes('http://192.168.1.50:11434');
    const route = resolveProviderRoute('ollama', '/api/chat', routes);
    expect(route?.origin).toBe('http://192.168.1.50:11434');
  });
});
