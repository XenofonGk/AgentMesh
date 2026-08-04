# Build context is the repo root (agentmesh/). Tagged per allowlist.ts's convention —
# agentmesh/<provider>:latest — since that's the only string the broker will ever accept
# as an image (apps/broker/src/allowlist.ts). Only `claude` has an adapter so far
# (packages/adapters/src/claude), so this is the only tag actually functional today;
# the entrypoint fails cleanly (a reported error + done(failed), not a crash loop) for
# any other AGENTMESH_PROVIDER value — see apps/runner/src/run-once.ts.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/proxy/package.json ./apps/proxy/
COPY apps/broker/package.json ./apps/broker/
COPY apps/runner/package.json ./apps/runner/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/skills/package.json ./packages/skills/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agentmesh/runner...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner ./apps/runner
RUN pnpm --filter @agentmesh/runner... build
RUN pnpm deploy --filter @agentmesh/runner --prod --legacy /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
# Belt-and-suspenders only: DockerSandboxProvider always sets User: '1000:1000' itself
# at the Docker API level (docker-sandbox-provider.ts), which overrides this — but a
# plain `docker run` of this image (e.g. local debugging) should still not default to
# root.
USER node
CMD ["node", "dist/main.js"]
