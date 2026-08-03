# AgentMesh — Project Context

Self-hostable control plane for running AI coding agents across multiple providers.
Every user brings their own credentials. Read `PLAN.md` for the full plan; this file is the
always-loaded summary.

## Current state
- **Phase:** 0 (Foundations)
- **Trajectory:** open-source, self-hosted, permanently. Not a service. No billing, no accounts
  beyond the operator's own users, no multi-tenant infrastructure.
- **Open decisions:** none. All five resolved (PLAN.md §2). Phase 0 may begin.
- **Stack:** pnpm workspaces · Next.js + Tailwind · Fastify · Postgres + Drizzle · Zod · Vitest ·
  `@anthropic-ai/claude-agent-sdk`. Do not substitute without a written reason.
- **Topology:** parallel bake-off. A `Run` fans out to N `Attempts`, one per provider. Attempts
  are fully independent; one failing never affects the others.

## Non-negotiable invariants

These are correctness requirements, not style preferences. A change violating any of them is a
bug regardless of whether tests pass. If a task appears to require violating one, **stop and ask**
rather than finding a workaround.

1. No plaintext credential is ever written to disk, a log, a DB column, or an HTTP response.
2. The credential proxy binds to `127.0.0.1` only.
3. Runner containers have no default outbound internet access — egress allowlist only.
4. A decrypted key exists only within a single request's scope, in proxy memory.
5. No secret ever appears in an `AgentEvent` (the type that reaches the browser).
6. Runner containers never receive API keys via env, file, or argument.

Every one of these has a corresponding test. If you touch this area, the test must still exist
and still pass.

## Architecture in one paragraph

Next.js UI talks to a Fastify API over REST (commands) and SSE (events). The API owns run
lifecycle and an encrypted credential vault. The orchestrator spawns one ephemeral Docker
container per run. That container runs a provider adapter and has **no credentials** — it sends
provider traffic to a localhost credential proxy which injects the auth header. All provider
output is normalized into a single `AgentEvent` discriminated union before it touches the DB or
the UI.

## Conventions

- TypeScript strict mode. `any` requires a comment explaining why.
- Validate all external input with Zod at the boundary. Trust nothing from a provider response.
- Errors: typed `Result`-style returns for expected failures; throw only for programmer error.
- Never log an object that could contain a credential — use the `redact()` helper.
- Every DB change is a Drizzle migration. Never hand-edit the schema.
- Tests colocate as `*.test.ts`. Security invariants live in `packages/core/security.test.ts`.
- Conventional Commits.
- **`AgentEvent` is defined once, in `packages/core`.** Never redefine or widen it locally —
  single-source typing across API, adapters, and browser is the whole reason for one language.
- Every attempt records cost, latency, tokens, and outcome. Non-optional; the eval loop needs it.

## Adding a provider adapter

Use the `adapter-authoring` skill. Do not freehand it — the event normalization rules are subtle
and inconsistency between adapters defeats the entire point of the abstraction.

## What to do when uncertain

Ask. This project has a security-sensitive core and a novice-friendly contribution surface; a
confidently wrong guess is more expensive here than a clarifying question. In particular, ask
before: changing the vault or proxy design, adding a dependency that touches crypto or network,
loosening a container restriction, or altering the `AgentEvent` schema.

## Anti-goals

- **Not a hosted service.** Do not build billing, subscription tiers, usage metering for
  revenue, or multi-tenant infrastructure. If a task seems to require them, it is out of scope —
  stop and ask.
- **Not hardened against hostile anonymous users.** The operator is assumed to trust their
  users. The README and SECURITY.md must say so plainly rather than implying protection that
  does not exist. Docker isolation is adequate *because of* this assumption.
- Do not add telemetry, analytics, or phone-home behavior. Self-hosted tools that call home
  lose trust permanently, and it is the first thing security-minded users check.
- Do not add an abstraction library for the model layer — writing it is the point.
- Do not add features not in PLAN.md. Put them in `IDEAS.md`.
