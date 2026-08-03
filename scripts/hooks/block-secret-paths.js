#!/usr/bin/env node
/**
 * PreToolUse hook for Read | Grep | Glob.
 *
 * Denies reads of credential-bearing paths: the operator's own `.env`, cloud and SSH
 * credentials, private keys. This is defense against R2 (prompt injection): an agent
 * following hostile instructions should not be able to read a secret in the first
 * place, independent of whether it would then leak it.
 *
 * This is a hook rather than a CLAUDE.md rule on purpose — see PLAN.md §9. A rule the
 * model reads is a rule injected text can argue it out of.
 *
 * `.env.example` is explicitly allowed: it is tracked, contains no real values, and is
 * the file an agent legitimately needs when adding configuration.
 */
import path from 'node:path';
import { readHookInput, deny, allow } from './lib/hook-io.js';

const DENIED_PATTERNS = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/, // .env.local, .env.production — but not .env.example
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.key$/,
  /(^|\/)secrets?(\/|$)/,
  /(^|\/)credentials$/,
  /\.kube\/config$/,
];

/** Collects every path-like field the three matched tools can carry. */
function candidatePaths(toolInput) {
  const values = [
    toolInput.file_path,
    toolInput.path,
    toolInput.notebook_path,
    toolInput.pattern,
    toolInput.glob,
  ];
  return values.filter((value) => typeof value === 'string' && value !== '');
}

const { tool_input: toolInput = {} } = await readHookInput();

for (const candidate of candidatePaths(toolInput)) {
  // Normalize so `./foo/../.env` and `.env` are judged the same way.
  const normalized = path.normalize(candidate).replaceAll('\\', '/');
  const match = DENIED_PATTERNS.find((pattern) => pattern.test(normalized));
  if (match) {
    deny(
      `Blocked by block-secret-paths hook: "${candidate}" targets a credential-bearing path.\n` +
        'Reading real secrets is denied even for legitimate-looking reasons — the guard ' +
        'exists because injected instructions look legitimate too.\n' +
        'If you need to know what configuration exists, read .env.example instead. If this ' +
        'is a false positive, ask the operator to adjust scripts/hooks/block-secret-paths.js.',
    );
  }
}

allow();
