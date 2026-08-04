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
    pnpm install --frozen-lockfile --filter @agentmesh/proxy...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/proxy ./apps/proxy
RUN pnpm --filter @agentmesh/proxy... build
RUN pnpm deploy --filter @agentmesh/proxy --prod --legacy /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
