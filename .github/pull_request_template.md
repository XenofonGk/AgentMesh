## What this changes and why

<!-- Short description. Link an issue if there is one. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass locally
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] If this adds/changes a provider adapter, I followed the `adapter-authoring` skill
      (`.claude/skills/adapter-authoring`)
- [ ] If this touches credentials, the vault, the proxy, container/runner config, auth,
      logging, or `AgentEvent` — I ran the `security-review` skill
      (`.claude/skills/security-review`) and it's clean
- [ ] No plaintext credential appears in code, logs, or this PR description
- [ ] DB schema changes are a Drizzle migration, not a hand edit
- [ ] This stays in scope: self-hosted only, no billing/telemetry/multi-tenant infra (see
      `CLAUDE.md` anti-goals)

## How this was tested

<!-- What you ran, what you checked. -->
