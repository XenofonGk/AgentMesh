#!/usr/bin/env node
/**
 * PostToolUse hook for Edit | Write.
 *
 * Typechecks and lints the workspace package that owns the edited file, so a type error
 * surfaces one tool call after it is introduced rather than at the end of a long
 * session. Runs `tsc -b` for the owning package (fast — project references mean only
 * that package and its dirty dependencies rebuild) plus eslint on the single file.
 *
 * Exits 2 when it finds real problems — for PostToolUse that feeds the output back to
 * the model, which is the point: the edit already happened, and the model should fix it
 * now rather than at the end of the session. Tooling failures (missing binary, timeout)
 * exit 0 instead, so a broken environment never wedges a session. CI is the gate; this
 * is only the fast feedback loop.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readHookInput } from './lib/hook-io.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const { tool_input: toolInput = {} } = await readHookInput();
const filePath = toolInput.file_path;

if (typeof filePath !== 'string' || !/\.(ts|tsx|mts|cts)$/.test(filePath)) {
  process.exit(0);
}

const absolute = path.resolve(REPO_ROOT, filePath);
if (!existsSync(absolute)) process.exit(0);

/** Walks up from the edited file to the nearest package.json inside the repo. */
function owningPackage(startPath) {
  let dir = path.dirname(startPath);
  while (dir.startsWith(REPO_ROOT) && dir !== REPO_ROOT) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

const packageDir = owningPackage(absolute);
if (packageDir === null) process.exit(0);

const problems = [];

function run(command, args, cwd) {
  try {
    execFileSync(command, args, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 120_000,
    });
    return null;
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    // A missing binary or a timeout is a tooling problem, not a code problem — stay quiet.
    if (error.code === 'ENOENT' || error.signal === 'SIGTERM') return null;
    return output === '' ? null : output;
  }
}

const typeErrors = run('pnpm', ['exec', 'tsc', '-b'], packageDir);
if (typeErrors !== null) problems.push(`tsc:\n${typeErrors}`);

const lintErrors = run('pnpm', ['exec', 'eslint', absolute], REPO_ROOT);
if (lintErrors !== null) problems.push(`eslint:\n${lintErrors}`);

if (problems.length > 0) {
  process.stderr.write(
    `typecheck-changed: ${path.relative(REPO_ROOT, absolute)} has problems.\n\n` +
      `${problems.join('\n\n')}\n\nFix these before moving on.\n`,
  );
  process.exit(2);
}

process.exit(0);
