import { describe, expect, it } from 'vitest';
import { RunTokenRegistry, type RunGrant } from './run-token.js';

const grant = { runId: 'run-1', userId: 'user-1', providers: ['claude'] as const };

describe('RunTokenRegistry', () => {
  it('resolves a token it issued to the grant it made', () => {
    const registry = new RunTokenRegistry();
    const { token } = registry.issue(grant, 60_000);
    expect(registry.resolve(token)?.userId).toBe('user-1');
  });

  it('rejects a token it never issued', () => {
    const registry = new RunTokenRegistry();
    registry.issue(grant, 60_000);
    expect(registry.resolve('a-token-from-somewhere-else')).toBeNull();
  });

  /**
   * The core property. A runner cannot ask for another user's credential because the
   * request carries no credential identifier at all — only "I am run R".
   */
  it('gives a compromised runner no way to name another user’s credential', () => {
    const registry = new RunTokenRegistry();
    const victim = registry.issue(
      { runId: 'run-v', userId: 'victim', providers: ['claude'] },
      60_000,
    );
    const attacker = registry.issue(
      { runId: 'run-a', userId: 'attacker', providers: ['claude'] },
      60_000,
    );

    // The attacker holds only their own token, and it resolves only to their own grant.
    expect(registry.resolve(attacker.token)?.userId).toBe('attacker');
    // Nothing in the interface accepts a user id or credential id from the caller.
    expect(registry.resolve(victim.token)?.userId).toBe('victim');
  });

  it('confines a run to the providers it declared', () => {
    const registry = new RunTokenRegistry();
    const { grant: issued } = registry.issue(grant, 60_000);
    expect(RunTokenRegistry.permits(issued, 'claude')).toBe(true);
    // A Claude run must not be able to spend the user's Gemini credit.
    expect(RunTokenRegistry.permits(issued, 'gemini')).toBe(false);
  });

  it('expires tokens', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const registry = new RunTokenRegistry(() => now);
    const { token } = registry.issue(grant, 1_000);

    expect(registry.resolve(token)).not.toBeNull();
    now = new Date(now.getTime() + 1_001);
    expect(registry.resolve(token)).toBeNull();
  });

  it('revokes every token for a run when it ends', () => {
    const registry = new RunTokenRegistry();
    const { token } = registry.issue(grant, 60_000);
    registry.revoke('run-1');
    // A container that outlives its run holds a token that resolves to nothing.
    expect(registry.resolve(token)).toBeNull();
  });

  it('prunes expired grants rather than growing without bound', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const registry = new RunTokenRegistry(() => now);
    registry.issue(grant, 1_000);
    registry.issue({ ...grant, runId: 'run-2' }, 1_000);
    expect(registry.size).toBe(2);

    now = new Date(now.getTime() + 5_000);
    registry.pruneExpired();
    expect(registry.size).toBe(0);
  });

  it('stores no raw token, so a dump of registry state is not a set of live tokens', () => {
    const registry = new RunTokenRegistry();
    const { token } = registry.issue(grant, 60_000);
    // Reach into private state deliberately: this asserts a storage property, and the
    // whole point is that it holds regardless of what the public API exposes.
    const state = JSON.stringify([
      ...(registry as unknown as { grants: Map<string, RunGrant> }).grants,
    ]);
    expect(state).not.toContain(token);
  });
});
