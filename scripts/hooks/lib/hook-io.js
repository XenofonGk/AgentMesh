/**
 * Shared plumbing for Claude Code hooks.
 *
 * Hooks are the only guardrails in this repo that the model cannot talk its way past:
 * they run outside its context, as separate processes. Instructions in CLAUDE.md are
 * advice; these are enforcement. Keep them dependency-free and fail-closed.
 *
 * Protocol: the hook receives one JSON object on stdin. Exit 0 allows the tool call,
 * exit 2 blocks it and shows stderr to the model. Any other exit code is a hook error
 * and does *not* block, so never rely on a throw to deny something.
 */

/** Reads and parses the hook payload from stdin. Returns {} if stdin is empty/invalid. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed payload means we cannot reason about the call. Allowing it is the
    // safe default only because the *other* hooks still run; log so it is visible.
    process.stderr.write('hook: could not parse stdin payload\n');
    return {};
  }
}

/** Blocks the tool call. `reason` is shown to the model so it can self-correct. */
export function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** Allows the tool call. */
export function allow() {
  process.exit(0);
}
