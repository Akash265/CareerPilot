# LaTeX compiler sidecar (Phase 13c, DECISIONS.md D209). Build from the repo root -- the context must be the pnpm workspace:
#   docker build -f services/latex-compiler/Dockerfile -t careerpilot-latex-compiler .
# Same two-stage pattern as services/maintenance-worker (D125), plus Debian's TeX Live packages and poppler-utils
# (pdftotext, used only by the test-mode /extract endpoint).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @ai-career/latex-compiler... \
 && pnpm --filter @ai-career/latex-compiler deploy --prod /out

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended lmodern poppler-utils \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8090
# Configuration comes from the environment only: LATEX_COMPILER_TOKEN (required), PORT, LATEX_COMPILER_TEST_MODE.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
