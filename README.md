# AgentMesh

An open-source, self-hostable control plane for running AI coding agents across multiple
model providers — where every user brings their own credentials.

AgentMesh is **software you run**, not a service you sign up for. There is no hosted tier.
Your provider keys never leave your instance, and the agent process never sees them at all
(see [`SECURITY.md`](SECURITY.md)).

> **Status: Phases 0–5 complete, Phase 6 (open-source readiness) in progress.** The
> credential vault + proxy, all five provider adapters (Claude, Gemini, DeepSeek, Grok,
> Ollama), the sandboxed runner/broker, the diff review UI, and the skills system
> (loader, validator, cross-provider delivery, in-app editor, eval harness) are all
> built and tested. See [`PLAN.md`](PLAN.md) for what each phase delivers.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Web UI (Next.js)                                        │
│  runs · live transcript · diff review · skill editor     │
└───────────────┬──────────────────────────────────────────┘
                │ SSE (events) + REST (commands)
┌───────────────▼──────────────────────────────────────────┐
│  API server (Fastify)                                    │
│  auth · run lifecycle · SSE fan-out · credential vault   │
└───┬─────────────────────────┬────────────────────────────┘
    │                         │
┌───▼──────────────┐   ┌──────▼───────────────────────────┐
│ Credential Vault │   │ Broker (orchestrator)             │
│ AES-256-GCM      │   │ plans runs, spawns runner         │
│ envelope encrypt │   │ containers via SandboxProvider    │
└───┬──────────────┘   └──────┬───────────────────────────┘
    │ (key never leaves)      │ spawn, no credentials
┌───▼─────────────────────────▼───────────────────────────┐
│  Credential Proxy  (internal Docker network only)        │
│  injects Authorization header · redacts · rate limits    │
└───▲─────────────────────────────────────────────────────┘
    │ HTTP, no auth header — proxy adds it
┌───┴─────────────────────────────────────────────────────┐
│  Runner container (per attempt, ephemeral)                │
│  provider adapter (claude|gemini|deepseek|grok|ollama)    │
│  workspace mount · egress allowlist · no secrets in env   │
└─────────────────────────────────────────────────────────┘
```

A `Run` fans out to N `Attempts`, one per provider, each in its own runner container.
Every provider's output is normalized into a single `AgentEvent` discriminated union
before it reaches the DB or the browser. See [`PLAN.md`](PLAN.md) §3 for the full
architecture writeup and the adapter contract.

## Quickstart

Requires Docker with Compose v2. Everything else runs in containers.

```bash
cp .env.example .env

# Both values ship as placeholders and are rejected at startup on purpose.
# Generate real ones:
openssl rand -base64 32   # → POSTGRES_PASSWORD
openssl rand -base64 32   # → VAULT_MASTER_KEY

docker compose up --build
```

`VAULT_MASTER_KEY` encrypts every stored provider credential. **Back it up somewhere
other than your database backup.** Lose it and every stored credential is unrecoverable;
leak it alongside a database dump and every stored credential is compromised. If you
start the instance with the wrong key it refuses to boot rather than showing you an empty
vault — see [`SECURITY.md`](SECURITY.md).

- Web UI → http://localhost:3000
- API liveness → http://localhost:3001/health
- API readiness, including Postgres → http://localhost:3001/readyz

All three services publish on `127.0.0.1` only. Exposing them more widely puts you outside
the supported threat model — read `SECURITY.md` first.

`docker compose up --build` is the whole deploy story — this is self-hosted software with
no hosted tier, so there is no Railway/Fly/Vercel button and none is planned.

<!-- TODO: demo gif -->

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
apps/broker       orchestrator — plans runs, spawns runner containers
apps/proxy        credential-injecting egress proxy
apps/runner       per-attempt runner entrypoint (provider adapter host)
packages/core     domain types, run state machine, event schema
packages/db       Drizzle schema + migrations
packages/adapters provider adapters (claude | gemini | deepseek | grok | ollama)
packages/skills   skill loader, validator, eval harness
infra/            Dockerfiles
scripts/hooks/    Claude Code hooks that enforce the security guardrails
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, test/lint conventions, and what to
read before touching adapters or security-sensitive code.

## License

MIT — see [`LICENSE`](LICENSE).
