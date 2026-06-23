<div align="center">

# Release Flight — Community Edition

**The open-source control surface for App Store Connect & Google Play.**

Metadata, screenshots, app previews, ASO intelligence, and a build-and-deploy
pipeline for games and apps — multi-tenant, self-hostable, yours to run.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Managed hosting](https://img.shields.io/badge/managed-releaseflight.com-0a7cff.svg)](https://releaseflight.com)

[Self-host](#-self-host-in-one-command) · [What's included](#-whats-in-the-open-edition) · [Architecture](#-architecture) · [Managed / Commercial](#-managed--commercial-edition) · [Contributing](CONTRIBUTING.md)

</div>

---

Release Flight is the storefront-operations tool with a build pipeline baked in:
manage your store metadata, screenshots and app previews across every locale,
run ASO keyword intelligence, and build/sign/ship your iOS & Android apps — all
from one self-hosted surface. It holds your store credentials, so it's built to
be **auditable and run on your own infrastructure**.

> This repository is the **Community Edition** — the full open-source core under
> AGPL-3.0. It is a complete, working product you can self-host for free. The
> managed cloud and the no-setup desktop installer are the
> [commercial edition](#-managed--commercial-edition).

## ✨ What's in the open edition

- **Metadata studio** — edit App Store Connect & Google Play listings across all
  locales, with diffing, history, and master-JSON import/export.
- **Screenshots & app previews** — upload, organize, apply-to-locales, validate
  against store specs, and push.
- **ASO intelligence** — keyword scoring, competitor tracking, AI keyword
  suggestions, and a daily-check engine.
- **Build & deploy pipeline** — a macOS runner that clones your repo, detects the
  framework, builds IPA/AAB/APK, signs, and deploys to Firebase / App Store
  Connect / Google Play.
- **Multi-tenant by design** — workspace isolation enforced by **PostgreSQL
  Row-Level Security** (not just app code), per-member app scoping, append-only
  audit log.
- **Secure by default** — AES-256-GCM secrets at rest, strict per-request CSP
  with nonces, SSRF guards on every outbound user URL, CSRF on every mutation.

## 🚀 Self-host in one command

> **Requirements:** Docker + Docker Compose. (The macOS build runner additionally
> needs Xcode / Android SDK on a Mac — see [docs](docs/).)

```bash
git clone https://github.com/gripati/releaseflight.git
cd releaseflight
./scripts/install.sh        # generates secrets, builds images, migrates, starts everything
```

Then open <http://localhost:3000> and sign in with the owner account printed by
the installer. That's it — no license, no limits, unlimited seats.

For development instead of a container stack, see [CONTRIBUTING.md](CONTRIBUTING.md).

## 🧱 Architecture

A pnpm + Turbo monorepo (Next.js 15 / React 19, Prisma + Postgres with RLS,
BullMQ workers).

```
apps/
  web      Next.js app — 90+ /api/v1 route handlers, App Router pages
  worker   BullMQ consumers (ASO research, metadata fetch jobs)
  runner   macOS build agent — clone → detect → build → sign → deploy
packages/
  core     store adapters (Apple/Google/Firebase) + crypto + SSRF guard + errors
  db       Prisma schema + RLS policies + tenant context
  secrets  AES-256-GCM envelope encryption
  storage  filesystem / S3 object storage
  aso      ASO keyword intelligence (client-bundle-safe)
  api-contracts  zod request/response contracts
  cache · jobs · observability · email · ui
```

Tenant isolation, secrets-at-rest, CSP, and SSRF protections are **invariants** —
see [docs/07_SECURITY.md](docs/07_SECURITY.md) and the rest of [`docs/`](docs/).

## 💼 Managed / Commercial edition

Release Flight is **open-core**. This repo is the complete, free, self-hostable
core. The commercial edition adds — and funds the project with — the parts most
people don't want to run themselves:

- **Managed cloud** at [releaseflight.com](https://releaseflight.com) — we host
  it; you skip the ops.
- **No-setup desktop installer** — a signed macOS app that installs and runs the
  whole stack for you (no Docker knowledge needed).
- **Licensing & seat management, billing, and the operator console.**

Don't want to manage infrastructure? [Buy a license / use the managed cloud →](https://releaseflight.com)

## 📜 License

Community Edition is licensed under **GNU AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
A separate **commercial license** is available for organizations that cannot meet
the AGPL's terms. See [LICENSING.md](LICENSING.md) for the full picture and the
open-core boundary.

## 🤝 Contributing

This repo is the upstream source of truth for the open core — contributions are
welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Found a security issue?
Please follow [SECURITY.md](SECURITY.md).
