# No `# syntax` directive on purpose: use Docker’s BUILT-IN BuildKit frontend
# (Docker 23+), which supports RUN --mount=type=cache etc. — so the build never
# fetches docker/dockerfile from Docker Hub (a flaky deploy host can fail that).
#
# GamePublisher Web — production image (Next.js standalone)
#
# Multi-stage build:
#   1. deps  — installs pnpm + workspace dependencies (cached)
#   2. build — generates Prisma client + builds Next.js (standalone output)
#   3. runtime — minimal Alpine image, only standalone server + Prisma engine
#
# Build & run:
#   docker build -f apps/web/Dockerfile -t gp-web:latest .
#   docker run --rm -p 3000:3000 --env-file .env gp-web:latest

# Pin the base image by IMMUTABLE multi-arch digest, not a floating tag, so a
# rebuild can't silently pull a different (regressed/compromised) base layer.
# The `22-alpine` tag is kept for readability; the @sha256 digest is what Docker
# resolves. Bump both together (Dependabot tracks the docker ecosystem here).
ARG NODE_VERSION=22-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd

# ────────────────────────────────────────────────────────────────────
# Stage 1 — base with pnpm
# ────────────────────────────────────────────────────────────────────
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
COPY apps/web/package.json apps/web/
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
    pnpm install --frozen-lockfile

# ────────────────────────────────────────────────────────────────────
# Stage 3 — build Next.js + generate Prisma client
# ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /repo /repo
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @marquee/db prisma:generate
RUN pnpm --filter @marquee/web build

# ── Phase 0: source-leak closure ─────────────────────────────────────
# 1. Delete all server-side source maps emitted by Next.js.
#    (productionBrowserSourceMaps:false already suppresses client maps;
#    server maps in .next/server/**/*.map are still written and must go.)
RUN find /repo/apps/web/.next -name '*.map' -delete

# 2. Strip source-pointing fields from workspace package stubs that
#    Next standalone copies alongside the server bundle. The standalone
#    server inlines all workspace code and never loads these stubs'
#    `main`/`types`/`module`/`exports` at runtime, so removing those
#    fields is safe. They do leak the original TypeScript module layout.
RUN find /repo/apps/web/.next/standalone/packages -name 'package.json' \
      -exec node -e " \
        const fs=require('fs'); \
        const f=process.argv[1]; \
        const p=JSON.parse(fs.readFileSync(f,'utf8')); \
        delete p.main; delete p.types; delete p.module; delete p.exports; \
        fs.writeFileSync(f,JSON.stringify(p)); \
      " {} \;

# 3. Materialize the generated Prisma client (+ musl engine) and the @prisma
#    package set into REAL directories. The generated .prisma lives only inside
#    the pnpm store post-generate (no root symlink in a clean build), and
#    BuildKit can't reliably cross-stage-COPY pnpm's symlinked dirs — so resolve
#    + cp -RL (dereference) here, then COPY plain dirs into runtime.
RUN set -eu; \
    PC="$(find /repo/node_modules/.pnpm -maxdepth 3 -type d -path '*@prisma+client@*/node_modules/.prisma' | head -1)"; \
    test -n "$PC"; \
    mkdir -p /prisma-out/.prisma /prisma-out/@prisma; \
    cp -RL "$PC/." /prisma-out/.prisma/; \
    cp -RL /repo/node_modules/@prisma/. /prisma-out/@prisma/

# ────────────────────────────────────────────────────────────────────
# Stage 4 — minimal runtime
# ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
RUN for n in 1 2 3 4 5; do apk add --no-cache libc6-compat openssl tini ca-certificates && break; [ "$n" = 5 ] && exit 1; echo "apk retry $n/5 (transient mirror DNS)"; sleep 4; done && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone build output already includes a tree-shaken node_modules
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

# Prisma engines + schema (required at runtime for migrations + connections).
# Sourced from the materialized real dirs (see build stage) — not pnpm symlinks.
COPY --from=build --chown=nextjs:nodejs /repo/packages/db/prisma ./packages/db/prisma
COPY --from=build --chown=nextjs:nodejs /prisma-out/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /prisma-out/@prisma ./node_modules/@prisma

# Release version (passed by CI from the git tag) — read by the server layout and
# shown in the sidebar footer. Placed after the COPYs so a version-only rebuild keeps
# them cached. Runtime ENV (not a NEXT_PUBLIC build inline) → no `next build` rerun.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

USER nextjs
EXPOSE 3000

# Healthcheck — fail container if /api/v1/healthz isn't 200 for >30s
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/v1/healthz || exit 1

# tini → proper PID 1 (signal forwarding, zombie reaping)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
