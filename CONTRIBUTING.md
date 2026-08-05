# Contributing to AgentMesh

Thanks for the interest. AgentMesh is self-hosted, open-source software with a
security-sensitive core (credential vault, credential proxy, container isolation) — please
read this before opening a PR.

## Getting a dev environment running

The README's [Quickstart](README.md#quickstart) and [Local development](README.md#local-development)
sections are the source of truth for setup — don't duplicate them here, just follow them:

```bash
pnpm install
pnpm typecheck   # tsc across every workspace package
pnpm lint        # eslint
pnpm test        # vitest
pnpm build       # packages, then apps
```

Node 22 and pnpm 10 are required. `docker compose up --build` runs the full stack if you
need to exercise it end to end rather than just the unit/integration suite.

## Before you touch adapters or security-sensitive code

**Read the skills in `.claude/skills/` first — they are not optional background reading,
they are the procedure.**

- **`adapter-authoring`** — required before adding or modifying a provider adapter
  (`packages/adapters/*`), changing how provider output is normalized into `AgentEvent`,
  or touching the `ModelAdapter` interface. `CLAUDE.md` is explicit: do not freehand this —
  event normalization is subtle and inconsistency between adapters defeats the point of
  having a shared abstraction.
- **`security-review`** — required before any change touching credentials, the vault, the
  credential proxy, container/runner configuration, authentication, logging, or the
  `AgentEvent` schema. Run it before opening a PR that touches `apps/proxy`,
  `apps/broker`, `packages/db`, or auth code.

If a task seems to require loosening a container restriction, widening `AgentEvent`, or
changing the vault/proxy design, stop and open an issue to discuss it first rather than
sending a PR — see the non-negotiable invariants in [`CLAUDE.md`](CLAUDE.md) and
[`SECURITY.md`](SECURITY.md).

## Tests, typecheck, lint

- `pnpm typecheck` and `pnpm lint` must pass. TypeScript strict mode is on; an `any`
  requires a comment explaining why.
- `pnpm test` runs the Vitest suite. Tests colocate as `*.test.ts` next to the code they
  cover. Security invariants live in `packages/core/security.test.ts` — if you touch the
  area those tests cover, the tests must still exist and still pass; deleting or weakening
  one to make CI green is not an acceptable fix.
- Every DB change is a Drizzle migration — never hand-edit the schema.
- Validate all external input with Zod at the boundary. Trust nothing from a provider
  response.

## Commit convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
`fix:`, `docs:`, `chore:`, `refactor:`, `test:`, etc.). Keep commits scoped and the subject
line under ~72 characters.

## Branching / PRs

- Branch from `main`, open a PR against `main`.
- CI runs typecheck, lint, format check, tests, a gitleaks secret scan, and a
  `docker compose build` on every PR, including forks — fork PRs get a read-only token and
  no repository secrets (see `.github/workflows/ci.yml`).
- Keep PRs focused. If a change touches the vault, proxy, or container isolation, say so
  explicitly in the description and confirm you ran the `security-review` skill.

## Scope

This project is self-hosted only, permanently — no billing, no multi-tenant
infrastructure, no telemetry. Features outside `PLAN.md` belong in `IDEAS.md`, not in a PR.
If you're unsure whether something is in scope, ask in an issue before building it.

## Code of Conduct

Participation in this project is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
