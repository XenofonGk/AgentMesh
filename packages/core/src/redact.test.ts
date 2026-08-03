import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from './redact.js';

describe('redact', () => {
  it('drops values under credential-shaped keys', () => {
    const out = redact({
      apiKey: 'hunter2',
      api_key: 'x',
      Authorization: 'y',
      name: 'ok',
    });
    expect(out).toEqual({
      apiKey: REDACTED,
      api_key: REDACTED,
      Authorization: REDACTED,
      name: 'ok',
    });
  });

  it('drops credential-shaped values regardless of key name', () => {
    const out = redact({ note: 'key is sk-ant-abcdefghijklmnopqrstuvwxyz012345 ok' });
    expect(out).toEqual({ note: `key is ${REDACTED} ok` });
  });

  it('redacts nested structures and arrays', () => {
    const out = redact({ users: [{ token: 'abc' }, { ok: 'fine' }] });
    expect(out).toEqual({ users: [{ token: REDACTED }, { ok: 'fine' }] });
  });

  it('redacts error messages and stacks without throwing', () => {
    const error = new Error('failed with Bearer aaaaaaaaaaaaaaaaaaaaaaaa');
    const out = redact(error) as { message: string };
    expect(out.message).toBe(`failed with ${REDACTED}`);
  });

  it('survives cyclic input', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(() => redact(node)).not.toThrow();
  });

  it('leaves non-sensitive primitives untouched', () => {
    expect(redact({ count: 3, enabled: true, missing: null })).toEqual({
      count: 3,
      enabled: true,
      missing: null,
    });
  });
});
