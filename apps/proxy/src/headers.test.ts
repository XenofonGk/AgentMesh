import { describe, expect, it } from 'vitest';
import { filterInboundHeaders, RUN_TOKEN_HEADER } from './headers.js';

describe('filterInboundHeaders', () => {
  it('keeps the small set of headers the upstream API needs', () => {
    const out = filterInboundHeaders({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    });
    expect(out).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    });
  });

  /**
   * The property this module exists for: a runner cannot spoof or shadow the header the
   * proxy is about to inject, because its own copy is never forwarded at all.
   */
  it('drops auth-shaped headers the runner sent, unconditionally', () => {
    const out = filterInboundHeaders({
      authorization: 'Bearer attacker-controlled',
      'x-api-key': 'attacker-controlled-key',
      'proxy-authorization': 'Basic whatever',
      cookie: 'agentmesh_session=stolen',
    });
    expect(out).toEqual({});
  });

  it('drops the host header, so it cannot influence anything downstream', () => {
    const out = filterInboundHeaders({ host: 'attacker.example.com' });
    expect(out).toEqual({});
  });

  it('drops the run-token header itself — it authenticates the caller, it is not upstream-bound', () => {
    const out = filterInboundHeaders({ [RUN_TOKEN_HEADER]: 'some-run-token' });
    expect(out).toEqual({});
  });

  it('ignores non-string header values (arrays, undefined) rather than forwarding them oddly', () => {
    const out = filterInboundHeaders({
      accept: ['application/json', 'text/event-stream'],
      'content-type': undefined,
    });
    expect(out).toEqual({});
  });
});
