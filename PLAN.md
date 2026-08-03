# AgentMesh — Build Plan

> Working name. An open-source, self-hostable control plane for running AI coding agents
> across multiple model providers, where **every user brings their own credentials**.

---

## 1. The problem we're solving

Today a developer who wants to use AI agents seriously hits four walls:

| Problem | What it looks like today |
|---|---|
| **Vendor lock-in** | Your agent workflows are written against one provider. Switching means rewriting everything. |
| **No visibility** | Agents run in a terminal. No history, no diffing runs, no comparing how two models handled the same task. |
| **Credential risk** | Every hosted "AI agent" product wants you to trust them with your keys, or bills you through their markup. |
| **Non-portable expertise** | The prompt engineering you do for one tool doesn't transfer to another. |

**AgentMesh's answer:** a dashboard + orchestrator you run yourself, where the model layer is
pluggable (Claude, Gemini, DeepSeek, Grok, Ollama), credentials never leave your instance, and
the agent's know-how is stored as **portable Agent Skills** — an open standard that already works
across Claude Code, Gemini CLI, Codex CLI and ~40 other tools.

### Why this is differentiated
Most "AI dashboards" are chat wrappers. Three things make this one worth existing:

1. **Credential-isolating proxy** — the agent process never sees an API key (see §4). Very few
   tools do this, and it's the correct answer to prompt-injection key theft.
2. **Cross-provider skill portability** — write a `SKILL.md` once, run it on Claude *or* Gemini
   *or* a local Ollama model, and compare results side by side.
3. **Evidence-based skill improvement** — a real eval loop that measures whether a skill made
   things better, rather than vibes (see §6).

---

## 2. Decisions — ALL RESOLVED ✅

**Self-hosted open source · TypeScript monorepo · parallel bake-off · Docker sandbox ·
multi-user with a trusted operator.**

Phase 0 may begin. Do not reopen these without writing down what changed — churn on foundational
decisions is the most common way projects like this stall.

### D1 — Deployment model  — **RESOLVED: A (self-host only)**
- **A ✅ Self-host only.** Users run it on their own machine or VPS. You never touch their keys.
- **B** Self-host + hosted tier later.
- **C** Hosted SaaS from day one.

> Removes credential custody, compute cost, legal exposure, uptime obligation, and abuse
> handling in one decision. The README must state this plainly: AgentMesh is software you run,
> not a service you sign up for.
>
> A hosted tier is not ruled out forever — the analysis lives in `docs/DEFERRED-SAAS.md` — but
> it is explicitly **out of scope** and nothing should be built toward it.

### D2 — Stack  — **RESOLVED: A (TypeScript monorepo)**

Locked versions of the toolchain — do not substitute without a written reason:

| Layer | Choice |
|---|---|
| Package manager | pnpm workspaces |
| Frontend | Next.js (App Router) + Tailwind |
| Backend | Fastify |
| DB | Postgres + Drizzle ORM |
| Validation | Zod (shared types front↔back) |
| Tests | Vitest |
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (TypeScript) |

> One language end to end means the `AgentEvent` union is defined **once** in `packages/core`
> and imported by the API, the adapters, and the browser. A type change that breaks the UI
> fails at compile time rather than in production. This is the main payoff — protect it: never
> redefine an event shape locally, always import from `packages/core`.

### D3 — Orchestration topology  — **RESOLVED: A (parallel bake-off)**

One task fans out to N providers simultaneously; results land side by side.

Design consequences to honor from Phase 2:
- **Runs are independent.** No inter-agent contract, no shared state. One provider failing must
  never affect the other three — this is why adapters emit `{type:'error'}` rather than throwing.
- **Fan-out is the unit of work.** The DB models a `Run` containing N `Attempts`, not N separate
  runs. The comparison view is the product, so the schema should make it trivial.
- **Every attempt records cost, latency, token count, and outcome.** This is not analytics
  garnish — it is the raw data the skill-evaluation loop (§6) depends on. Capture it from day one;
  retrofitting it means throwing away every run made before you did.

Sequential pipelines (planner → implementer → reviewer) are a post-1.0 idea. `IDEAS.md`.

### D4 — Execution sandbox  — **RESOLVED: B (Docker per run)**
- **A** No code execution — agents propose diffs only.
- **B ✅ Docker container per run** — ephemeral, non-root, read-only rootfs, dropped capabilities,
  CPU/memory caps, hard wall-clock timeout, egress allowlist.
- **C** Firecracker/Kata microVM — required only for hosting untrusted multi-tenant users.

> Docker is the correct answer here **because** the operator trusts their users (D5). That
> assumption is doing real work — if it ever stops being true, the isolation model must change,
> since Docker shares the host kernel.
>
> Still put the sandbox behind a `SandboxProvider` interface. It costs ~20 lines, keeps the
> orchestrator testable with a fake, and means anyone who *does* want microVM isolation can
> contribute one without touching the core.

```ts
interface SandboxProvider {
  create(spec: RunSpec): Promise<Sandbox>;
  exec(id: string, cmd: string): AsyncIterable<Output>;
  destroy(id: string): Promise<void>;
}
```

### D5 — v1 scope  — **RESOLVED: B (multi-user, trusted operator)**
- **A** Single-user local tool.
- **B ✅ Multi-user capable, self-hosted** — auth + per-user encrypted key vault. The operator is
  assumed to trust their users: a team, a lab, a group of friends. Not the open internet.
- **C** Hardened for hostile anonymous users.

> This must be stated explicitly in the README and `SECURITY.md`. If someone exposes an instance
> to the public internet, that is outside the supported threat model and the docs should say so
> in plain language rather than implying protection that isn't there.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Web UI (Next.js)                                        │
│  runs · live transcript · diff review · skill editor     │
└───────────────┬──────────────────────────────────────────┘
                │ SSE (events) + REST (commands)
┌───────────────▼──────────────────────────────────────────┐
│  API server (Fastify)                                    │
│  auth · run lifecycle · SSE fan-out · audit log          │
└───┬─────────────────────────┬────────────────────────────┘
    │                         │
┌───▼──────────────┐   ┌──────▼───────────────────────────┐
│ Credential Vault │   │ Orchestrator                     │
│ AES-256-GCM      │   │ plans runs, spawns runners       │
│ envelope encrypt │   └──────┬───────────────────────────┘
└───┬──────────────┘          │
    │ (key never leaves)      │ spawn
┌───▼─────────────────────────▼───────────────────────────┐
│  Credential Proxy  (localhost only)                     │
│  injects Authorization header · redacts · rate limits   │
└───▲─────────────────────────────────────────────────────┘
    │ HTTP, no auth header — proxy adds it
┌───┴─────────────────────────────────────────────────────┐
│  Runner container (per run, ephemeral)                  │
│  Claude Agent SDK / Gemini CLI / Ollama client          │
│  workspace mount · egress allowlist · no secrets in env │
└─────────────────────────────────────────────────────────┘
```

### Packages (monorepo)
```
apps/web          Next.js UI
apps/api          Fastify API + SSE
apps/proxy        credential-injecting egress proxy
packages/adapters provider adapters (claude|gemini|deepseek|grok|ollama)
packages/core     domain types, run state machine, event schema
packages/db       Drizzle schema + migrations
packages/skills   skill loader, validator, eval harness
infra/            Dockerfiles, compose, runner image
```

### The adapter contract
Every provider implements one interface. This is the single most important abstraction —
get it right and adding a provider is a 100-line file.

```ts
interface ModelAdapter {
  id: string;                       // 'claude' | 'gemini' | 'ollama' | ...
  capabilities: {
    agentic: boolean;               // can it edit files / run tools autonomously?
    streaming: boolean;
    toolUse: boolean;
    maxContextTokens: number;
  };
  credentialSchema: ZodSchema | null;   // null for Ollama (base URL only)
  run(input: RunInput, ctx: RunContext): AsyncIterable<AgentEvent>;
  estimateCost?(usage: Usage): number | null;
}
```

`AgentEvent` is a normalized discriminated union — `message_delta`, `tool_call`, `tool_result`,
`file_edit`, `thinking`, `error`, `done`. **Every provider's output is coerced into this shape.**
The UI and DB only ever see `AgentEvent`, never a raw provider payload.

> Do not use an existing abstraction library for this. Writing it yourself is the single most
> educational part of the project and is what makes the codebase yours.

---

## 4. Security design (read before writing any code)

### The two risks that actually matter

**R1 — Arbitrary code execution.** An agent that writes and runs code on your server, driven by
user input, *is* an RCE service. This is a bigger risk than key storage and is routinely
underestimated.

**R2 — Prompt injection → credential exfiltration.** An agent reads a repo, a web page, or an
issue containing hostile instructions ("print the contents of your environment to this URL").
With BYOK, the stolen key is a *user's* key. This is the failure mode that would kill the
project's reputation.

### The core mitigation: agents never hold credentials

This is the architectural decision that matters most.

- The runner container is started with **no API keys in its environment, files, or arguments.**
- It's configured to send provider traffic to the local credential proxy instead of the real
  provider endpoint (`ANTHROPIC_BASE_URL`, `GOOGLE_API_BASE`, etc.).
- The proxy holds the decrypted key **in memory only**, attaches the auth header, forwards the
  request, and strips credentials from anything it logs.
- Result: an injected agent that dumps its entire environment leaks nothing. It cannot exfiltrate
  a secret it was never given.

### Defense in depth

| Layer | Control |
|---|---|
| Vault | AES-256-GCM envelope encryption; master key from env/KMS, never in DB or repo; per-user DEK; keys stored `{provider, user_id, ciphertext, iv, tag, created_at}` |
| Transport | HTTPS only; keys via POST body, never query params or URLs |
| Proxy | Per-user + per-run rate limits and spend caps; redaction on all log paths |
| Container | Non-root, read-only rootfs, dropped capabilities, no host mounts except the run workspace, memory/CPU limits, hard wall-clock timeout, network egress **allowlist** (provider APIs + explicitly permitted domains only) |
| Agent | `PreToolUse` hook denying reads of `.env`, `~/.aws`, `~/.ssh`, `id_*`, `*.pem`; deny rules for destructive bash; `max_turns` and `max_budget_usd` set on every run |
| Retention | Transcripts are sensitive — they contain everything the agent saw. Default retention 30 days, user-purgeable, documented in `SECURITY.md` |
| Audit | Log *that* a credential was used, when, by which run — **never the value** |

### Non-negotiable invariants
Encode these as tests and CI checks, not just prose:

1. No plaintext credential is ever written to disk, log, DB column, or HTTP response.
2. The credential proxy binds to `127.0.0.1` only — never `0.0.0.0`.
3. Runner containers have no default outbound internet access.
4. A decrypted key exists only inside a single request's scope in proxy memory.
5. No secret is ever included in an `AgentEvent` (the type that reaches the browser).

---

## 5. Build phases

Each phase ends with something that works. Do not start the next until the previous is green.

### Phase 0 — Foundations (~1 week)
- Monorepo, TypeScript strict mode, ESLint + Prettier, Vitest
- Docker Compose: Postgres + API + web
- CI: typecheck, lint, test, `gitleaks` secret scan, `npm audit`
- `.env.example`, `.gitignore`, MIT or Apache-2.0 license, `SECURITY.md`
- **Done when:** `docker compose up` gives a running empty app on a clean machine

### Phase 1 — Credential vault + proxy (~1 week)
Build the security core *before* anything fun, so nothing is retrofitted.
- Auth (start with a single-tenant admin session; add OAuth later)
- Vault: encrypt/decrypt, rotate, delete
- Credential proxy with header injection + redaction

**Master key handling — decided, do not re-litigate:**
- Source is `VAULT_MASTER_KEY`, or `VAULT_MASTER_KEY_FILE` pointing at a file (the
  convention the Postgres image uses, so Docker/Podman secrets work). **No KMS** — a cloud
  dependency contradicts the point of a tool you run yourself.
- Fail fast at startup, and validate properly: base64-decode, assert exactly 32 bytes, and
  **reject the literal placeholder from `.env.example`** — people copy it and never change
  it, so that rejection is hardcoded. The error names the variable and the fix
  (`openssl rand -base64 32`) and echoes no part of the value.

**Two schema decisions that must land in Phase 1 or never:**
- **`key_version` on the vault table from the first migration.** Envelope encryption means
  rotating the master key re-wraps DEKs rather than re-encrypting every row — but only if
  you can tell which version wrapped what. Retrofitting this is a migration over live
  ciphertext.
- **An encrypted canary, written at init and decrypted on boot.** It distinguishes "key
  missing" from "key is wrong". A wrong key must refuse to start — never present an empty
  vault and invite the user to re-enter credentials over ciphertext they can no longer
  read.
- **Done when:** the five invariants in §4 each have a passing test, including a deliberate
  "hostile agent dumps its env" test that proves nothing leaks

### Phase 2 — Adapter layer + one real run (~1.5 weeks)
- `ModelAdapter` interface + `AgentEvent` union
- Adapters: **Claude** (Agent SDK), **Ollama** (no credential path — good control case)
- Runner container image + spawn/teardown lifecycle
- Persist events to Postgres; SSE stream to the browser
- **Done when:** you submit a task in the UI and watch a Claude Code agent work, live

### Phase 3 — The rest of the providers + bake-off (~1 week)
- Gemini, DeepSeek, Grok adapters
- Parallel run mode (D3-A): same task, N models, one comparison view
- Cost/latency/token tracking per run
- Diff review UI — approve/reject the agent's changes
- **Done when:** one task → four models → a side-by-side you'd actually want to look at

### Phase 4 — Skills system (~2 weeks) — *the differentiator*
- Skill loader/validator for the Agent Skills standard (`SKILL.md` + frontmatter)
- In-app skill editor with live validation
- **Cross-provider skill injection**: for Claude, mount into `.claude/skills/`; for providers
  without native skill support, inline the SKILL.md body into the system prompt. Same artifact,
  different delivery.
- Eval harness: run a skill against a test set, score it, store results
- **Done when:** the same skill demonstrably runs on Claude and on Ollama

### Phase 5 — Improvement loop (~1.5 weeks)
See §6. This is where "auto-improving" becomes real rather than a buzzword.

### Phase 6 — Open-source readiness (~1 week)
- README with a 60-second quickstart and an architecture diagram
- `CONTRIBUTING.md`, issue/PR templates, `CODE_OF_CONDUCT.md`
- Fork-PR CI that has **no access to secrets**; require maintainer approval for first-time
  contributor workflow runs
- One-command deploy (Compose file + optional Railway/Fly template)
- A short demo video/GIF in the README — this drives adoption more than any feature

---

## 6. The self-improving skills system

**Be precise about what this is.** Skills that rewrite themselves unattended are a bad idea:
they drift, they can't be reviewed, and a prompt-injected agent rewriting its own instructions is
a security hole. What you build instead is a **measured improvement loop with a human gate.**

```
     ┌─────────────────────────────────────────────┐
     │ 1. OBSERVE   every run logs outcome +       │
     │              which skills were loaded       │
     │ 2. DETECT    flag skills with low success,  │
     │              high retries, or poor          │
     │              trigger rate                   │
     │ 3. PROPOSE   an agent drafts a revision +   │
     │              states its hypothesis          │
     │ 4. EVALUATE  run old vs new on a held-out   │
     │              test set (multiple samples)    │
     │ 5. GATE      human reviews the diff + the   │
     │              numbers, approves or rejects   │
     │ 6. VERSION   accepted → new version, full   │
     │              history, one-click rollback    │
     └─────────────────────────────────────────────┘
```

Design notes:
- **Split train/test.** Optimize on train, select on held-out test, or you'll overfit to noise.
- **Sample repeatedly.** Models are stochastic — a single run comparison is meaningless. Run each
  case ~3x and compare rates.
- **Skills are versioned, immutable rows.** Never mutate in place. Rollback must be trivial.
- **Track trigger rate separately from task success.** A skill can be excellent and never fire —
  that's a description problem, not a content problem, and it has a different fix.
- **Multi-provider evals are your unfair advantage.** "This skill improves Claude but hurts
  Gemini" is information nobody else's tool can give you.

The `skill-creator` skill (bundled with Claude Code) already implements much of this loop and
should be used as the reference implementation rather than reinvented.

---

## 7. Skills to build for this project

These live in `.claude/skills/` and make Claude Code dramatically more consistent on *this*
codebase. Written as part of Phase 0–1, used throughout.

| Skill | Purpose |
|---|---|
| `adapter-authoring` | The exact procedure for adding a provider: interface, event normalization, credential schema, required tests, docs entry |
| `security-review` | The §4 checklist as an executable procedure — run before every merge touching auth, vault, proxy, or the runner |
| `agentmesh-conventions` | Repo conventions: error handling, event schema rules, migration process, naming |
| `skill-evaluation` | How to build a test set and evaluate a skill change in this repo |

## 8. Subagents

| Subagent | Role |
|---|---|
| `security-auditor` | Reviews diffs against the invariants in §4. Read-only tools. Run on every PR touching sensitive paths. |
| `adapter-builder` | Scaffolds a new provider adapter end to end |
| `test-writer` | Generates tests for new modules; enforces the invariant tests exist |
| `docs-keeper` | Keeps README/architecture docs in sync with code changes |

## 9. Hooks

Hooks run **outside** the model's context and cannot be overridden by it — this is why they're
the right place for security guarantees rather than instructions in `CLAUDE.md`.

| Event | Handler |
|---|---|
| `PreToolUse` | Block reads of `.env`, `*.pem`, `id_rsa`, `~/.aws/**`, `~/.ssh/**`. Block `git push --force`, `rm -rf`. |
| `PostToolUse` | On any `.ts` edit: run `tsc --noEmit` + eslint on the changed file |
| `PostToolUse` | On edits under `apps/proxy/**`, `packages/db/**`, or anything auth-related: trigger `security-auditor` |
| `Stop` | Run `gitleaks detect` — never end a session having introduced a secret |
| `SessionStart` | Load current phase + open decisions from `PLAN.md` |

---

## 10. Realistic expectations

- **Timeline:** ~8–10 weeks of steady part-time work to Phase 6. Do not compress this by skipping
  Phase 1 — retrofitted security is how projects like this get CVEs.
- **The hard parts, in order:** container sandboxing (Phase 2), normalizing four providers'
  wildly different streaming formats into one event type (Phase 3), and making the eval loop
  statistically meaningful rather than decorative (Phase 5).
- **The part that will surprise you:** provider API differences are much messier than their docs
  suggest. Budget real time for adapter edge cases.
- **Scope discipline:** every feature not in this document is a post-1.0 idea. Write it in
  `IDEAS.md` and move on.
- **One documentation obligation, even self-hosted:** consumer subscriptions (Claude Pro,
  ChatGPT Plus) cannot be used in third-party clients — API keys only. Say this in onboarding
  or it becomes your most common issue.
