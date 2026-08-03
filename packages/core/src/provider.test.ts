/**
 * Guards the resolver seam.
 *
 * The point of `ProviderResolver` is that there is exactly one place that reads
 * credential rows. Nothing enforces that except this test — a comment saying "go
 * through the resolver" is the kind of rule that holds until the first hurried Phase 2
 * afternoon. It currently has nothing to catch, which is the intended state: it exists
 * so that the day someone adds a second lookup, CI says so.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/**
 * Where credential rows may legitimately be read: the schema that defines them, and the
 * resolver implementation itself once it exists (Phase 1).
 */
const ALLOWED = [
  'packages/db/src/schema.ts',
  'packages/db/src/vault/', // Phase 1 — the resolver and its repository
];

/** Direct table access, in either Drizzle or raw SQL form. */
const DIRECT_ACCESS =
  /\bcredentials\b\s*\)|from\s+credentials\b|\bcredentials\b\s*,|insert\s+into\s+credentials\b|update\s+credentials\b|\.from\(\s*credentials\s*\)/i;

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob('{apps,packages}/*/src/**/*.ts', { cwd: REPO_ROOT })) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.endsWith('.test.ts')) continue;
    if (ALLOWED.some((allowed) => normalized.startsWith(allowed))) continue;
    files.push(normalized);
  }
  return files;
}

describe('credential access is routed through the resolver', () => {
  it('finds no direct credential-table access outside the vault', async () => {
    const offenders: string[] = [];

    for (const file of await sourceFiles()) {
      const contents = await readFile(path.join(REPO_ROOT, file), 'utf8');
      // Comments discuss the table by name constantly — this file included. Only code
      // counts, so strip block and line comments before matching.
      const code = contents.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (DIRECT_ACCESS.test(code)) offenders.push(file);
    }

    expect(
      offenders,
      'Query credentials through ProviderResolver, not directly — see packages/core/src/provider.ts',
    ).toEqual([]);
  });

  it('scans a non-trivial number of files, so a broken glob cannot pass silently', async () => {
    // Without this, a glob that matches nothing makes the test above vacuously green.
    expect((await sourceFiles()).length).toBeGreaterThan(5);
  });
});
