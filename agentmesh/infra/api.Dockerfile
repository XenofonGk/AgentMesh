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
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/skills/package.json ./packages/skills/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @agentmesh/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @agentmesh/api... build
RUN pnpm deploy --filter @agentmesh/api --prod --legacy /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
