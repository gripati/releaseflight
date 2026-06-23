# Release Flight Test Strategy

A layered ("pyramid") strategy. The guiding rule: **every security-audit fix
(`MARQ-xxx`) is pinned by a test, so a regression turns a suite red.**

## Layers

| Layer | Tool | Runs | What it covers |
|-------|------|------|----------------|
| **Unit** | Vitest (per-package `vitest.config.ts`) | `pnpm test:unit` | Pure logic: scoring, validation, crypto, locale, CSP builder, SSRF classifier, zod contracts, secret envelope, signing, runner guards. |
| **Contract** | Vitest (`api-contracts`) | `pnpm --filter @marquee/api-contracts test` | zod request/response schemas — the API trust boundary (`deploy.ts`, `credential.ts`). |
| **Integration** | Vitest + Testcontainers Postgres (`packages/db`) | `pnpm test:integration` | **RLS tenant isolation** against a real Postgres as `gp_app` with `rls.sql` applied: cross-tenant read/write/delete, `tenantTransaction` atomicity, AuditEvent append-only, `assertTenantTablesForceRls`. |
| **Security regression** | aggregate of the above | `pnpm test:security` | The audit-fix suites (see matrix below) in one fast command (no Docker). RLS/append-only live in the integration layer. |
| **E2E** | Playwright (`e2e/`) | `pnpm test:e2e` | Critical flows incl. `cross-tenant-isolation`, `csrf-and-ratelimit`, `public-endpoints`, auth, credentials. |
| **Load** | k6 (`tests/load/`) | `pnpm test:load:*` | Baseline throughput, public-probe + auth-burst rate-limit behaviour, push fairness. |
| **Chaos** | bash drills (`tests/chaos/`) | `pnpm test:chaos` | Postgres/Redis/worker/storage failure + `rls-violation-probe` + `tenant-context-missing`. |

## Security-regression coverage matrix

| Fix | Layer | Test file |
|-----|-------|-----------|
| MARQ-001/011/012/016/020 app-scope BOLA | integration + e2e | `db/__tests__/rls.test.ts`, `e2e/cross-tenant-isolation.spec.ts` (+ `assertAppAccess` helper) |
| MARQ-002 force-RLS boot guard | integration | `db/__tests__/rls.test.ts` (`assertTenantTablesForceRls`) |
| MARQ-003 secrets-at-rest | unit | `secrets/__tests__/FilesystemSecretProvider.test.ts` (encrypt + lazy plaintext) |
| MARQ-005/024 storage signing + timing-safe | unit | `storage/__tests__/signedUrl.test.ts` |
| MARQ-004/007/014 keystore redaction | unit | `runner/build/__tests__/runProcess.test.ts` |
| MARQ-006/031 git transport + ref | unit + contract | `runner/build/__tests__/git.test.ts`, `api-contracts/__tests__/deploy.test.ts` |
| MARQ-008/033 SSRF guard | unit | `core/net/__tests__/ssrfGuard.test.ts` |
| MARQ-013 `tenantTransaction` atomicity | integration | `db/__tests__/rls.test.ts` |
| MARQ-015/018/019 rate-limit + clientIp | unit | `web/lib/__tests__/rateLimitWrap.test.ts` |
| MARQ-022 AuditEvent append-only | integration | `db/__tests__/rls.test.ts` |
| MARQ-023 localPath allowlist | unit | `runner/__tests__/processBuildRun.test.ts` |
| MARQ-027 idempotency binding | unit | `web/lib/__tests__/idempotency.test.ts` |
| MARQ-034 CSP nonce | unit | `web/lib/__tests__/csp.test.ts` |

## Running

```bash
pnpm test            # everything (turbo)
pnpm test:security   # audit-fix regressions (fast, no Docker)
pnpm test:unit       # all unit suites
pnpm test:integration  # RLS — needs Docker (see below)
pnpm test:e2e        # Playwright (needs the app running)
```

**Integration tests need Docker.** On OrbStack:
```bash
export DOCKER_HOST=unix:///Users/emrepehlevan/.orbstack/run/docker.sock
export TESTCONTAINERS_RYUK_DISABLED=true
pnpm --filter @marquee/db test:integration
```

## Conventions
- Co-locate tests in `__tests__/` next to the source. Keep unit tests
  deterministic — no real network/DNS (use literal IPs or `localhost`), stub and
  restore `process.env` in `afterEach`.
- A security/behavior change ships in the same PR as its test. If you weaken a
  `MARQ-xxx` invariant and no test goes red, the coverage gap IS the bug — add it.
- The `qa-test-engineer` agent owns this doc and the suites; pair with the
  domain agent whose code you're testing.

## Known gaps / roadmap
- `apps/worker` has no unit suite yet (its logic is integration-shaped: BullMQ +
  `tenantTransaction` + SSRF-guarded research). Add a vitest config + tests for
  the pure mappers next.
- Intra-tenant (per-member app-scope) BOLA is covered by the `assertAppAccess`
  helper + integration RLS; add a dedicated Playwright case for a scoped member
  hitting an out-of-scope `appId` (expect 403/404).
- Adopt a uniform `describe("MARQ-xxx: …")` naming so `test:security` can narrow
  by `-t` instead of by package filter.
