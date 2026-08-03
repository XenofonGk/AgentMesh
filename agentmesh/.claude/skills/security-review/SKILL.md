---
name: security-review
description: Security review procedure for AgentMesh. Use this skill whenever changes touch credentials, the vault, the credential proxy, container/runner configuration, authentication, logging, the AgentEvent schema, or network egress — and also whenever the user mentions security, secrets, API keys, sandboxing, prompt injection, or asks for a review before merging. Run this before any PR touching apps/proxy, packages/db, or auth code. Err on the side of triggering.
---

# AgentMesh Security Review

A change is not done because it works. In this codebase it is done when it provably cannot leak
a user's credentials and cannot be used to execute arbitrary code outside a sandbox.

## When to run
Any diff touching: `apps/proxy/**`, `apps/api/src/auth/**`, `apps/api/src/vault/**`,
`packages/db/schema/**`, `infra/runner/**`, logging utilities, or the `AgentEvent` type.
When in doubt, run it.

## Procedure

### Step 1 — Restate the invariants
Confirm each still holds after the change. Quote the specific line that guarantees it.

1. No plaintext credential written to disk, log, DB column, or HTTP response.
2. Credential proxy binds `127.0.0.1` only.
3. Runner containers have no default outbound internet — allowlist only.
4. Decrypted key exists only within one request's scope, in proxy memory.
5. No secret in any `AgentEvent`.
6. Runners never receive keys via env, file, or argument.

### Step 2 — Trace the credential path
For any change near the vault or proxy, trace a key end to end and write out where it exists in
plaintext and for how long. If the answer is longer than "in proxy memory during one request",
that is a finding.

### Step 3 — Injection review
Assume the agent has read hostile text instructing it to exfiltrate secrets. Ask:
- Could it read a credential? (It should have none to read.)
- Could it reach an attacker-controlled host? (Egress allowlist.)
- Could it write a secret somewhere the UI or DB would surface it?
- Could it disable its own guardrails? (Hooks run outside model context — verify the guard is a
  hook, not an instruction.)

### Step 4 — Sandbox review
For runner changes, verify: non-root, read-only rootfs, dropped capabilities, memory and CPU
limits, wall-clock timeout, no host mounts beyond the run workspace, egress allowlist intact.

A relaxed restriction requires an explicit written justification in the PR description. "It was
easier to develop with it off" is not one.

### Step 5 — Logging and redaction
Grep the diff for logging calls. Every logged object that could transit a credential must pass
through `redact()`. Check error paths too — leaks usually happen in error handlers, not happy
paths.

### Step 6 — Tests
Each invariant touched must have a test that fails if the invariant is removed. A test that
passes whether or not the protection exists is worse than no test — it manufactures confidence.

Include at least one adversarial test where relevant: a runner that attempts to dump its
environment and assert nothing sensitive is present.

## Output format

```
## Security Review: <change>

**Verdict:** PASS / PASS WITH FINDINGS / BLOCK

### Invariants
1. ... ✅ / ⚠️ / ❌  — evidence
(through 6)

### Findings
- [severity] description — file:line — suggested fix

### Tests
- covered / missing
```

Be direct. If something is unsafe, say BLOCK. A security review that never blocks anything is
not a review.
