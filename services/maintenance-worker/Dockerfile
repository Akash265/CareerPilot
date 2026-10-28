# Maintenance worker (daily retention sweep). Build from the repo root -- the context must be the pnpm workspace:
#   docker build -f services/maintenance-worker/Dockerfile -t careerpilot-maintenance-worker .
# Workspace packages ship raw TypeScript (no build step), so the worker runs under tsx, exactly as
# `pnpm --filter @ai-career/maintenance-worker start` does outside Docker (DECISIONS.md D125).

# Base image comes from Docker's official-images mirror on AWS ECR Public, not Docker Hub: CI's anonymous
# Docker Hub token fetch is flaky/rate-limited on shared GitHub runners (same class of failure as D88).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
# pnpm pinned by the root package.json "packageManager" field.
RUN corepack enable
COPY . .
# `pnpm deploy --prod` copies this one service plus the workspace packages and production node_modules it
# needs into /out. tsx is a production dependency of this service: it is the runtime for the TS sources.
RUN pnpm install --frozen-lockfile --filter @ai-career/maintenance-worker... \
 && pnpm --filter @ai-career/maintenance-worker deploy --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Configuration comes from the environment only (loadEnv); no .env file is baked into the image.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
