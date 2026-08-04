import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/agentmesh' };

describe('loadConfig', () => {
  it('applies defaults when only required values are set', () => {
    const config = loadConfig(base);
    expect(config.PROXY_PORT).toBe(3002);
    expect(config.NODE_ENV).toBe('development');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...base, PROXY_PORT: '99999' })).toThrow(/PROXY_PORT/);
  });

  /** There is no PROXY_HOST — see config.ts and constants.ts (invariant 2). */
  it('has no bind-host key at all', () => {
    const config = loadConfig(base);
    expect('PROXY_HOST' in config).toBe(false);
  });

  it('never echoes a configured value in its error message', () => {
    const secretish = 'postgres://user:sk-ant-supersecretvalue@db/agentmesh';
    try {
      loadConfig({ DATABASE_URL: secretish, PROXY_PORT: 'not-a-number' });
      expect.unreachable('expected loadConfig to throw');
    } catch (error) {
      expect(String(error)).not.toContain('sk-ant-supersecretvalue');
    }
  });
});
