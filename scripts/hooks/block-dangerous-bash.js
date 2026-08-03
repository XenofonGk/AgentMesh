#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 *
 * Two jobs:
 *   1. Block destructive or history-rewriting commands (PLAN.md §9) — `rm -rf`,
 *      `git push --force`, `docker system prune`, piping a download into a shell.
 *   2. Block commands that read credential-bearing files, which is the obvious way
 *      around block-secret-paths.js: `cat .env` is a read the Read tool would deny.
 *
 * Deliberately conservative about what it *allows*: the cost of a false positive is a
 * one-line explanation to the operator, and the cost of a false negative is a deleted
 * working tree or a leaked key.
 */
import { readHookInput, deny, allow } from './lib/hook-io.js';

/** [pattern, why] — `why` is shown to the model so it can pick a safe alternative. */
const RULES = [
  [
    /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    'recursive force-delete (`rm -rf`). Delete specific paths explicitly instead.',
  ],
  [
    /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|(^|\s)-f(\s|$))/,
    'force push. Use --force-with-lease, and only when the operator has asked for it.',
  ],
  [
    /\bgit\s+reset\s+--hard\b/,
    'hard reset — it discards uncommitted work irrecoverably.',
  ],
  [
    /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
    'git clean — it deletes untracked files permanently.',
  ],
  [
    /\bgit\s+checkout\s+\.(\s|$)/,
    'checkout of the whole tree — it discards local changes.',
  ],
  [
    /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|d)?sh\b/,
    'piping a download straight into a shell. Download, read, then run.',
  ],
  [
    /\bdocker\s+(system\s+prune|volume\s+rm|volume\s+prune)/,
    'destructive Docker cleanup — this can delete the Postgres volume holding the vault.',
  ],
  [/\bmkfs|\bdd\s+if=[^\n]*of=\/dev\//, 'a raw device write.'],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, 'a fork bomb.'],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, 'a world-writable permission change.'],
  [/\bhistory\s+-c|\bshred\b/, 'history or evidence destruction.'],
];

/**
 * Commands that read files. Paired with the secret-path patterns below so `cat .env`
 * is denied while `cat package.json` is not.
 */
const READERS =
  /\b(cat|bat|less|more|head|tail|strings|xxd|od|grep|rg|ag|awk|sed|cp|mv|scp|rsync|base64|openssl|tar|zip|source|\.)\b/;

const SECRET_TARGETS =
  /(^|[\s'"=/])(\.env(?!\.example)(\.[\w-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^\s'"]*\.(pem|p12|pfx|key)|[^\s'"]*\/\.ssh\/[^\s'"]*|[^\s'"]*\/\.aws\/[^\s'"]*|[^\s'"]*\/\.npmrc|[^\s'"]*\/\.netrc)($|[\s'";|&)])/;

/** `env`, `printenv`, and `export -p` dump the whole environment, secrets included. */
const ENV_DUMP = /\b(printenv|export\s+-p)\b|(^|[\s;|&])env(\s*$|\s*[|>])/;

const { tool_input: toolInput = {} } = await readHookInput();
const command = typeof toolInput.command === 'string' ? toolInput.command : '';

if (command === '') allow();

for (const [pattern, why] of RULES) {
  if (pattern.test(command)) {
    deny(`Blocked by block-dangerous-bash hook: this command performs ${why}`);
  }
}

if (READERS.test(command) && SECRET_TARGETS.test(command)) {
  deny(
    'Blocked by block-dangerous-bash hook: this command reads a credential-bearing file.\n' +
      'Shell access is not a way around the Read-tool guard. Use .env.example to learn ' +
      'what configuration exists.',
  );
}

if (ENV_DUMP.test(command)) {
  deny(
    'Blocked by block-dangerous-bash hook: dumping the environment can expose secrets.\n' +
      'Read the specific variable you need by name, or consult .env.example.',
  );
}

allow();
