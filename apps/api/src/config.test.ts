import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/agentmesh' };

describe('loadConfig', () => {
  it('applies defaults when only required values are set', () => {
    const config = loadConfig(base);
    expect(config.API_PORT).toBe(3001);
    expect(config.NODE_ENV).toBe('development');
    expect(config.WEB_ORIGIN).toBe('http://localhost:3000');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...base, API_PORT: '99999' })).toThrow(/API_PORT/);
  });

  it('never echoes a configured value in its error message', () => {
    const secretish = 'postgres://user:sk-ant-supersecretvalue@db/agentmesh';
    try {
      loadConfig({ DATABASE_URL: secretish, API_PORT: 'not-a-number' });
      expect.unreachable('expected loadConfig to throw');
    } catch (error) {
      expect(String(error)).not.toContain('sk-ant-supersecretvalue');
    }
  });
});
