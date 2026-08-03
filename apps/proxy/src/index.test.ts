import { describe, expect, it } from 'vitest';
import { PROXY_BIND_HOST } from './index.js';

describe('invariant 2 — the credential proxy binds to loopback only', () => {
  it('binds to 127.0.0.1', () => {
    expect(PROXY_BIND_HOST).toBe('127.0.0.1');
  });

  it('is never a wildcard address', () => {
    expect(['0.0.0.0', '::', '*']).not.toContain(PROXY_BIND_HOST as string);
  });
});
