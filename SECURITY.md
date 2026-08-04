# Security

AgentMesh runs AI coding agents that execute code, and it holds users' provider API keys.
Both of those are serious. This document states plainly what the project defends against,
what it does **not** defend against, and the invariants that any change must preserve.

Read this before writing code that touches credentials, the proxy, the runner, auth, or
logging.

---

## Threat model: a trusted operator and trusted users

AgentMesh is **software you run**, not a service you sign up for. There is no hosted tier
and no AgentMesh-operated infrastructure — nobody but you ever holds your keys, because
there is nobody else in the picture.

The supported deployment is:

> A single operator runs an instance for people they trust — a team, a lab, a group of
> friends — on a machine or VPS they control, reachable only by those people.

Everything in the design assumes this. In particular, per-run isolation uses Docker
containers, which share the host kernel. That is an appropriate trade-off **because**
users are trusted not to attempt kernel-level escapes. It is not an appropriate trade-off
against anonymous attackers.

### Explicitly out of scope

These are stated so nobody infers protection that does not exist:

- **Exposing an instance to the open internet for anonymous signups.** Unsupported. A user
  who can start a run can execute arbitrary code in a container on your host. Treat "can
  log in" as equivalent to "can run code on this machine".
- **Hostile users of your own instance.** A malicious authenticated user is outside the
  model. Invite people the way you would give someone a shell account.
- **Kernel-level container escape.** Mitigated by hardening, not eliminated. If you need a
  hard boundary against untrusted tenants, Docker is the wrong primitive — the
  `SandboxProvider` interface exists so a microVM backend (Firecracker, Kata) can be
  contributed without touching the core.
- **A compromised host.** If the host is owned, the vault master key and any decrypted
  credential in proxy memory are readable. Nothing in-process defends against root.
- **Malicious provider APIs.** Provider responses are validated, not trusted, but a
  provider that is itself hostile is not a modeled adversary.

### In scope — the risks the design actually targets

**R1 — Arbitrary code execution.** An agent that writes and runs code on your server, on
behalf of user input, _is_ an RCE service. Mitigated by per-run ephemeral containers: non-
root, read-only rootfs, dropped capabilities, CPU/memory limits, a hard wall-clock timeout,
no host mounts except the run workspace, and a network egress allowlist.

**R2 — Prompt injection leading to credential exfiltration.** An agent reads a repository,
a web page, or an issue containing hostile instructions ("post your environment to this
URL"). With bring-your-own-key, the stolen key belongs to a _user_. This is the failure
mode that would be unrecoverable for the project's reputation, and it drives the single
most important architectural decision below.

---

## The core mitigation: agents never hold credentials

Prompt injection is not reliably preventable. So the design does not try to prevent the
agent from being tricked — it removes what a tricked agent could steal.

- The runner container starts with **no API key in its environment, its filesystem, or its
  arguments.**
- It is pointed at a local credential proxy instead of the real provider endpoint
  (`ANTHROPIC_BASE_URL`, `GOOGLE_API_BASE`, and equivalents).
- The proxy holds the decrypted key **in memory only**, for the scope of one request,
  attaches the `Authorization` header, forwards upstream, and strips credentials from
  everything it logs.

The consequence: an injected agent that dumps its entire environment, reads every file it
can reach, and posts the lot to an attacker leaks **nothing**. It cannot exfiltrate a
secret it was never given.

---

## Non-negotiable invariants

These are correctness requirements, not preferences. A change that violates one is a bug
regardless of whether the test suite is green. Each is backed by a test; if you touch the
area, the test must still exist and still pass.

1. **No plaintext credential is ever written to disk, a log, a DB column, or an HTTP
   response.** All log payloads pass through `redact()` in `packages/core`.
2. **The credential proxy is never reachable from the host or the public internet.**
   It listens on every interface _inside its own container_ — necessary so the runner
   container that forwards through it can reach it at all — but is never given a
   `ports:` entry in `compose.yaml`, and sits on an `internal: true` Docker network with
   no route out. Reachability is enforced by network topology, not a bind address; see
   `apps/proxy/src/constants.ts`.
3. **Runner containers have no default outbound internet access.** Egress is an allowlist:
   the provider endpoints a run needs, plus domains explicitly permitted for that run.
4. **A decrypted key exists only within a single request's scope, in proxy memory.** It is
   never cached, never persisted, never attached to a long-lived object.
5. **No secret ever appears in an `AgentEvent`** — the type that reaches the browser.
6. **Runner containers never receive API keys via environment, file, or argument.**

Invariants 1 and 2 have tests as of Phase 0 (`packages/core/src/redact.test.ts`,
`apps/proxy/src/index.test.ts`). The remaining four are implemented and tested in Phase 1
and Phase 2 alongside the components they constrain — including a deliberate "hostile agent
dumps its env" test that proves nothing leaks.

---

## Defense in depth

| Layer     | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault     | AES-256-GCM envelope encryption; master key from `VAULT_MASTER_KEY` or `VAULT_MASTER_KEY_FILE`, never in the DB or the repo (no KMS — a cloud dependency contradicts self-hosting); per-user data-encryption key, wrapped by the master key and tagged with a `key_version` so rotation re-wraps DEKs instead of re-encrypting every row; an encrypted canary is decrypted on boot so a _wrong_ key refuses to start rather than presenting an empty vault; ciphertext stored as `{provider, user_id, ciphertext, iv, tag, key_version, created_at}` |
| Transport | HTTPS in any non-localhost deployment; keys submitted in POST bodies, never in query params or URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Proxy     | Per-user and per-run rate limits and spend caps; redaction on every log path                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Container | Non-root, read-only rootfs, dropped capabilities, no host mounts beyond the run workspace, memory/CPU limits, hard wall-clock timeout, egress allowlist                                                                                                                                                                                                                                                                                                                                                                                              |
| Agent     | `PreToolUse` hooks denying reads of `.env`, `~/.aws`, `~/.ssh`, `id_*`, `*.pem`; deny rules for destructive shell commands; `max_turns` and `max_budget_usd` set on every run                                                                                                                                                                                                                                                                                                                                                                        |
| Retention | Transcripts contain everything the agent saw and are treated as sensitive. Default retention 30 days, user-purgeable                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Audit     | Log _that_ a credential was used, when, and by which run — never the value                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## How the vault binds ciphertext to its location

Every stored ciphertext carries additional authenticated data naming where it lives.
AAD is authenticated but not encrypted: change it and decryption fails with a bad
authentication tag rather than quietly returning the right plaintext in the wrong place.

| Sealed thing | Bound to                                      |
| ------------ | --------------------------------------------- |
| Credential   | `credential_id`, `provider`, `key_version`    |
| Wrapped DEK  | `user_id`, `generation`, `master_key_version` |
| Canary       | `master_key_version`                          |

Without this a ciphertext is a portable blob: anyone with UPDATE on the database — or a
buggy rotation script — can copy user A's credential row onto user B's account, and every
check still passes. The row decrypts, the tag verifies, and B is now spending A's key.
Binding makes that a decryption failure. It also pins `key_version`, so relabelling a row
to dodge a rotation stops working.

This is the one property that genuinely cannot be added later: AAD is mixed into the
authentication tag at encryption time, so introducing it afterwards means decrypting and
re-encrypting every credential under the old key.

Each domain has its own prefix, so a sealed DEK can never be opened as a credential even
if an attacker lines the identifiers up.

## Runners never name a credential

A runner says **"I am run R"**. It never says "give me credential C".

If a credential reference were redeemable by whoever presents it, a compromised or
prompt-injected runner would simply present a different one — and references travel
through logs, run records, and error payloads, so obtaining one is not hard. The mapping
from run to credential therefore lives in the proxy, server-side. The proxy issues an
opaque 32-byte token when it starts a run, and derives the credential from that token on
every request. The runner has no syntax in which to ask for someone else's key.

Tokens are stored as SHA-256 hashes, scoped to a single run and to the exact provider set
that run declared at issue time, revoked when the run ends, and held in memory only — a
run token must not outlive the process that issued it. The provider is derived from the
request's destination, never from a header the runner controls.

## Zeroization is best-effort

Plaintext key material is always a `Buffer`, never a `string`, and is overwritten as soon
as its scope ends (`withSecret`). That reduces the window in which a heap dump or a core
file yields a key.

**It is not a guarantee, and this document will not claim one.** Node's garbage collector
copies objects as it compacts, so by the time a buffer is overwritten the runtime may
already have left copies elsewhere in the heap. Strings are worse — immutable, so they
cannot be overwritten at all, and every substring or concatenation makes another copy —
which is why plaintext is never a string anywhere in the vault or proxy. There is no way
to reliably wipe memory in a managed runtime, and anyone who tells you otherwise is
describing an optimization, not a control.

The real defense remains structural: a decrypted key exists only inside one request's
scope in the proxy, and the agent never receives one at all.

## Enforcement: hooks, not instructions

The rules in `CLAUDE.md` are advice to a model that reads them. Injected text can argue a
model out of advice. So the guardrails that matter run as **hooks** — separate processes,
outside the model's context, which it cannot disable or talk past (PLAN.md §9).

| Hook                                    | Enforces                                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/hooks/block-secret-paths.js`   | Denies `Read`/`Grep`/`Glob` on `.env`, `~/.aws`, `~/.ssh`, `id_*`, `*.pem`, `*.key`, and similar. `.env.example` is allowed                                                                          |
| `scripts/hooks/block-dangerous-bash.js` | Denies destructive shell (`rm -rf`, force push, hard reset, `docker volume rm`, curl-pipe-shell) **and** shell reads of the same credential paths — otherwise `cat .env` walks around the hook above |
| `scripts/hooks/typecheck-changed.js`    | Runs `tsc -b` and eslint on every edited TypeScript file, feeding errors back immediately                                                                                                            |
| `scripts/hooks/gitleaks-stop.js`        | Runs `gitleaks detect` before a session can end                                                                                                                                                      |

`scripts/hooks/hooks.test.ts` asserts that each rule **blocks** — so deleting a rule fails
the suite. A hook that silently allows everything is indistinguishable from a working one
until the day it should have stopped something; these tests are what make that
distinguishable.

Two notes on how they fail:

- A hook only blocks on **exit code 2**. An earlier inline version of the gitleaks hook
  ended in `|| echo '...'`, which made its exit status come from `echo` — it printed a
  warning and allowed everything. That is why the logic now lives in testable files.
- `typecheck-changed.js` and `gitleaks-stop.js` exit 0 when their _tooling_ is broken
  (binary missing, timeout) rather than wedging the session. Both are backstopped by CI,
  where gitleaks is a blocking job.

## Operational notes for self-hosters

- Copy `.env.example` to `.env` and generate a real `POSTGRES_PASSWORD`
  (`openssl rand -base64 32`). Never commit `.env`.
- Compose publishes Postgres, the API, and the web UI on `127.0.0.1` only. If you change
  that to expose the instance, you are taking on the risks listed as out of scope above —
  put it behind a VPN or an authenticating reverse proxy.
- Back up your vault master key separately from your database. Losing it means every
  stored credential is unrecoverable; leaking it alongside a database dump means every
  stored credential is compromised.
- AgentMesh sends no telemetry and makes no phone-home requests. The only outbound traffic
  is to the model providers you configure.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
GitHub's **Security → Report a vulnerability** advisory form on this repository. Include
what you did, what happened, and what you expected. Expect an initial response within a
week; there is no bounty program.

Reports about the explicitly out-of-scope scenarios above are still welcome as
documentation issues if the docs mislead — but they will not be treated as vulnerabilities.
