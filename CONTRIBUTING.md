# Contributing to Release Flight

Thanks for helping build Release Flight! This repository is the **upstream source
of truth** for the open-source core. Contributions here flow into both the
community edition and the commercial product.

## Development setup

**Requirements:** Node.js ≥ 22, pnpm ≥ 9, Docker (for the backing services).

```bash
pnpm install
cp .env.example .env            # then fill in the blanks (see comments in the file)
docker compose up -d            # postgres, redis, minio, mailhog (dev infra)
pnpm db:push                    # apply schema + RLS policies
pnpm db:seed                    # optional: seed a dev workspace
pnpm dev                        # start web + worker
```

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm dev` | Run web + worker in watch mode |
| `pnpm build` | Build everything |
| `pnpm typecheck` | Type-check all packages (must be green) |
| `pnpm lint` | ESLint |
| `pnpm test` | Run the test suites |
| `pnpm test:security` | Security-regression suite |
| `pnpm db:push` / `db:reset` / `db:rls` | Schema + Row-Level-Security |

## Project layout

See the [Architecture section of the README](README.md#-architecture). In short:
`apps/{web,worker,runner}` + `packages/*`, a pnpm + Turbo monorepo.

## Non-negotiable invariants

Some things in this codebase encode fixed security decisions. Please don't
regress them — PRs that do will be asked to change:

1. **Tenant isolation is enforced by Postgres RLS**, not just TypeScript.
2. **Secrets are AES-256-GCM encrypted at rest** — never log or return them.
3. **Every mutating route** does CSRF + auth + role checks.
4. **Outbound fetches of user-supplied URLs** go through the SSRF guard.
5. **Production CSP** has no `'unsafe-inline'` in `script-src` — inline scripts
   carry the request nonce.

There's a deeper write-up in [`docs/`](docs/) (start with `07_SECURITY.md`).

## Pull requests

- Keep PRs focused; one logical change per PR.
- `pnpm typecheck` and `pnpm lint` must pass. Add tests for behavior changes.
- Describe the motivation, not just the diff.
- By contributing, you agree your contribution is licensed under the project's
  AGPL-3.0 (and may be offered under the project's commercial license as part of
  the open-core dual-licensing — this is standard for open-core projects).

## The open-core boundary

Licensing, billing, the desktop installer, the storefront, and the operator admin
are **commercial** and live outside this repo (see [LICENSING.md](LICENSING.md)).
The seam in this repo is the `@marquee/license` stub — please keep its public
surface stable, but don't try to re-implement licensing here.

## Security issues

Do **not** open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
