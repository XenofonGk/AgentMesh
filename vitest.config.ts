import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace *sources*, so `pnpm test` never depends on a prior
    // build and a stale dist/ can't mask a broken change.
    alias: {
      '@agentmesh/core': src('core'),
      '@agentmesh/db': src('db'),
      '@agentmesh/adapters': src('adapters'),
      '@agentmesh/skills': src('skills'),
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
