# AgentMesh

An open-source, self-hostable control plane for running AI coding agents across multiple
model providers — where every user brings their own credentials.

AgentMesh is **software you run**, not a service you sign up for. There is no hosted tier.
Your provider keys never leave your instance, and the agent process never sees them at all
(see [`SECURITY.md`](SECURITY.md)).

> **Status: Phase 0 — foundations.** The monorepo, toolchain, and Compose stack are in
> place; the app itself is intentionally empty. See [`PLAN.md`](PLAN.md)
> for what each phase delivers.

## Quickstart

Requires Docker with Compose v2. Everything else runs in containers.

```bash
cp .env.example .env
# Set a real POSTGRES_PASSWORD — e.g. openssl rand -base64 32
docker compose up --build
```

- Web UI → http://localhost:3000
- API liveness → http://localhost:3001/health
- API readiness, including Postgres → http://localhost:3001/readyz

All three services publish on `127.0.0.1` only. Exposing them more widely puts you outside
the supported threat model — read `SECURITY.md` first.

## Local development

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm typecheck   # tsc across every workspace package
pnpm lint        # eslint
pnpm test        # vitest
pnpm build       # packages, then apps
```

## Layout

```
apps/web          Next.js UI
apps/api          Fastify API + SSE
apps/proxy        credential-injecting egress proxy
packages/core     domain types, run state machine, event schema
packages/db       Drizzle schema + migrations
packages/adapters provider adapters (claude | gemini | deepseek | grok | ollama)
packages/skills   skill loader, validator, eval harness
infra/            Dockerfiles
scripts/hooks/    Claude Code hooks that enforce the security guardrails
```

## License

MIT — see [`LICENSE`](LICENSE).
