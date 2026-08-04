# Build context is the repo root (agentmesh/).
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
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/skills/package.json ./packages/skills/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agentmesh/broker...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/broker ./apps/broker
RUN pnpm --filter @agentmesh/broker... build
RUN pnpm deploy --filter @agentmesh/broker --prod --legacy /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
# Deliberately not USER node: this process holds a mounted Docker socket, which is
# host-root-equivalent access regardless of the container's own UID — running as
# non-root here would not reduce what this process can do, only make the (very common)
# case where the socket is root:root on the host a startup failure instead of a no-op.
EXPOSE 3003
CMD ["node", "dist/index.js"]
