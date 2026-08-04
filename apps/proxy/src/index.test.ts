import { describe, expect, it } from 'vitest';
import { PROXY_BIND_HOST } from './index.js';

/**
 * Invariant 2 no longer lives in this constant — see constants.ts. This test now
 * documents the flip side of that: since the proxy listens on every interface inside
 * its own container, the only thing standing between it and the public internet is
 * compose.yaml never publishing a host port for it. That property can't be asserted
 * from unit tests; compose.smoke verification (manual, see SECURITY.md) is what proves
 * it. This test just guards against silently reintroducing a loopback bind, which would
 * make the proxy unreachable by the runner containers it exists to serve.
 */
describe('proxy bind address', () => {
  it('listens on every interface inside its own container', () => {
    expect(PROXY_BIND_HOST).toBe('0.0.0.0');
  });
});
