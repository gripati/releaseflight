# No `# syntax` directive on purpose: use Docker’s BUILT-IN BuildKit frontend
# (Docker 23+), which supports RUN --mount=type=cache etc. — so the build never
# fetches docker/dockerfile from Docker Hub (a flaky deploy host can fail that).
#
# GamePublisher Worker — BullMQ consumer (no HTTP server)
#
# Multi-stage strategy:
#   1. base   — Node + pnpm
#   2. deps   — install all workspace deps (cached layer)
#   3. build  — generate Prisma client + bundle src/ → dist/index.cjs via esbuild
#   4. deploy — pnpm deploy --prod to get a flat production node_modules
#   5. runtime — minimal Alpine image:
#                 • dist/index.cjs  (self-contained first-party bundle)
#                 • production node_modules for external deps (bullmq, ioredis, …)
#                 • Prisma engines + schema
#                 • NO .ts source, NO source maps, NO /repo copy

# Pinned by immutable multi-arch digest (see apps/web/Dockerfile note).
ARG NODE_VERSION=22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd

FROM node:${NODE_VERSION} AS base
RUN for n in 1 2 3 4 5; do apk add --no-cache libc6-compat openssl && break; [ "$n" = 5 ] && exit 1; echo "apk retry $n/5 (transient mirror DNS)"; sleep 4; done
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ────────────────────────────────────────────────────────────────────
# Stage 2 — install workspace dependencies (heavy, cached)
# ────────────────────────────────────────────────────────────────────
FROM base AS deps
# .npmrc is REQUIRED in the build: its public-hoist-pattern entries (*@prisma/*,
# *prisma*, *@swc/*) hoist Prisma to the root node_modules so the runtime COPY of
# node_modules/@prisma + .prisma works. Without it pnpm uses the strict symlink
# layout and those root paths don't exist → build fails.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/api-contracts/package.json packages/api-contracts/
COPY packages/aso/package.json packages/aso/
COPY packages/cache/package.json packages/cache/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/email/package.json packages/email/
COPY packages/jobs/package.json packages/jobs/
COPY packages/license/package.json packages/license/
COPY packages/observability/package.json packages/observability/
COPY packages/secrets/package.json packages/secrets/
COPY packages/storage/package.json packages/storage/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store/v3 \
    pnpm install --frozen-lockfile --prod=false

# ────────────────────────────────────────────────────────────────────
# Stage 3 — generate Prisma client + esbuild bundle
# ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /repo /repo
COPY . .
RUN pnpm --filter @marquee/db prisma:generate
RUN pnpm --filter @marquee/worker build

# Materialize the GENERATED Prisma client (+ linux-musl query engine) into a
# REAL dir. After `prisma generate` it lives only inside the pnpm store (there
# is no root node_modules/.prisma symlink in a clean build), so resolve its path
# dynamically and `cp -RL` (dereference). The hoisted deploy already ships the
# @prisma/client package + its deps, so runtime only overlays this generated
# .prisma/client. cross-stage COPY of plain dirs (not symlinks) is reliable.
RUN set -eu; \
    SRC="$(find /repo/node_modules/.pnpm -maxdepth 3 -type d -path '*@prisma+client@*/node_modules/.prisma' | head -1)"; \
    test -n "$SRC"; \
    mkdir -p /prisma-out/.prisma; \
    cp -RL "$SRC/." /prisma-out/.prisma/

# ────────────────────────────────────────────────────────────────────
# Stage 4 — production deploy directory (flat node_modules, no src)
# `pnpm deploy` copies only the production deps for @marquee/worker
# into /deploy, with a flat node_modules that CJS require() can find.
# We then defensively strip any @marquee/* source that pnpm may have
# linked in (they are bundled into dist/index.cjs already). Prisma + the
# bundle come straight from the build stage into runtime, so this stage
# only needs the deps tree to resolve the production dependency graph.
# ────────────────────────────────────────────────────────────────────
FROM base AS deploy
COPY --from=deps /repo /repo
# node-linker=hoisted is REQUIRED: esbuild inlines the @marquee/* packages into
# dist/index.cjs, so their *transitive* third-party deps (zod, openai, @aws-sdk,
# sharp, …) become DIRECT top-level require()s of the bundle. pnpm's default
# strict layout only exposes a package's direct deps at the top level, so those
# transitive deps would be unresolvable at runtime (Cannot find module 'zod').
# Hoisting flattens every prod dep to the top level so the bundle resolves them.
RUN pnpm --filter @marquee/worker deploy --prod --config.node-linker=hoisted /deploy
# Purge ALL first-party @marquee/* source — it is inlined in dist/index.cjs and
# must never ship. Deterministic (find -exec, not a shell glob that can silently
# no-op on no-match). Verified locally: 142 .ts files -> 0, while every
# externalized third-party dep still resolves from the flat node_modules.
RUN rm -rf /deploy/node_modules/@marquee && \
    find /deploy/node_modules/.pnpm -maxdepth 1 -name '@marquee+*' -exec rm -rf {} + 2>/dev/null || true

# ────────────────────────────────────────────────────────────────────
# Stage 5 — minimal runtime image
# ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
RUN for n in 1 2 3 4 5; do apk add --no-cache libc6-compat openssl tini ca-certificates && break; [ "$n" = 5 ] && exit 1; echo "apk retry $n/5 (transient mirror DNS)"; sleep 4; done && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

WORKDIR /app

ENV NODE_ENV=production

# The self-contained first-party bundle
COPY --from=build --chown=worker:nodejs /repo/apps/worker/dist/index.cjs ./dist/index.cjs

# Production node_modules for external deps (bullmq, ioredis, pino, zod, etc.)
# NO @marquee/* source — it is inlined in the bundle.
COPY --from=deploy --chown=worker:nodejs /deploy/node_modules ./node_modules

# Overlay the generated Prisma client + musl query engine onto the deploy's
# node_modules (which ships the @prisma/client package + deps but NOT the
# generated .prisma/client), plus the schema for runtime DB operations.
COPY --from=build --chown=worker:nodejs /prisma-out/.prisma ./node_modules/.prisma
COPY --from=build --chown=worker:nodejs /repo/packages/db/prisma ./packages/db/prisma

USER worker

# No HTTP server — Prometheus metrics port only if WORKER_METRICS_PORT is set
ENV WORKER_METRICS_PORT=9091
EXPOSE 9091

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.cjs"]
