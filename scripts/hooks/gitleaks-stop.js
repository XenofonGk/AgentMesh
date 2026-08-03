#!/usr/bin/env node
/**
 * Stop hook: never end a session having introduced a secret (PLAN.md §9).
 *
 * The previous inline version ended in `|| echo '...'`, which made the hook always
 * succeed — the shell's exit status came from `echo`, so a detected secret produced a
 * line of text and no consequence. That is the failure mode this whole hook layer
 * exists to avoid, so the logic lives in a file where it can be read and tested.
 *
 * Exit 2 blocks the stop and shows stderr to the model. A missing gitleaks binary is
 * reported loudly but does not block: this hook is a safety net, and a developer
 * without gitleaks installed should not be unable to end a session. CI runs gitleaks
 * as a blocking job, so a miss here is still caught before merge.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Two scans, because they cover different things and the working-tree one is the case
 * this hook actually exists for:
 *
 *   --no-git   files as they sit on disk, including everything still uncommitted. A
 *              secret written during a session is uncommitted almost by definition.
 *   (default)  commit history, catching a secret committed earlier in the session.
 *
 * `detect` alone scans only history — it does not look at the working tree at all, so
 * the obvious-looking single command would have let a freshly written key through.
 */
const SCANS = [
  ['detect', '--no-git', '--no-banner', '--redact', '--source', REPO_ROOT],
  ['detect', '--no-banner', '--redact', '--source', REPO_ROOT],
];

try {
  for (const args of SCANS) {
    execFileSync('gitleaks', args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
  }
} catch (error) {
  if (error.code === 'ENOENT') {
    process.stderr.write(
      'gitleaks-stop: gitleaks is not installed, so this session was not scanned for ' +
        'secrets. Install it (https://github.com/gitleaks/gitleaks) — CI will scan ' +
        'regardless, but that is a slower and more public place to find out.\n',
    );
    process.exit(0);
  }

  if (error.signal === 'SIGTERM') {
    process.stderr.write('gitleaks-stop: scan timed out; not blocking.\n');
    process.exit(0);
  }

  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
  process.stderr.write(
    'SECRET DETECTED — gitleaks found a potential credential in the working tree.\n\n' +
      `${output}\n\n` +
      'Do not commit. Remove the secret, and if it was ever committed, treat it as ' +
      'compromised and rotate it — rewriting history does not un-leak a pushed value.\n',
  );
  process.exit(2);
}

process.exit(0);
