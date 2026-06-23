# Licensing

Release Flight is **open-core**. This document explains exactly what is open,
what is commercial, and how the two licenses relate.

## The open-source core (this repository)

Everything in this repository is licensed under the
**GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)** — see
[LICENSE](LICENSE). You may run, study, modify, and redistribute it under those
terms, **for free**, forever.

The key AGPL obligation: **if you run a modified version of this software as a
network service, you must make your modified source available to its users.**
This is deliberate — it keeps the open core open, including for anyone who offers
it as a hosted service.

If you self-host Release Flight unmodified for your own organization, the AGPL
imposes no practical burden on you.

## Commercial license

A separate **commercial license** is available for organizations that:

- cannot comply with the AGPL's copyleft / source-disclosure terms, or
- want to embed Release Flight in a closed-source product, or
- want a managed, supported, warranted deployment.

The commercial license is dual-licensing of the **same core** — it does not give
you different core code, it gives you different *terms*. Buy it (or use the
managed cloud) at **<https://releaseflight.com>**.

## What is NOT in this repository (the commercial edition)

The following components are **proprietary** and are not part of the open core.
They are what the project sells to fund open development:

| Component | What it is |
|---|---|
| **Desktop installer (Tauri app)** | The signed macOS app that installs & runs the whole stack with no Docker knowledge. |
| **Storefront / landing site** | releaseflight.com marketing, pricing, checkout, and download surface. |
| **Operator admin console** | The vendor-side console for issuing licenses, seats, billing, and releases (2FA-gated). |
| **License & billing system** | Online activation, Ed25519 token verification, seat enforcement, the Polar billing integration, and the license server. |

In this open repository, the licensing seam is the `@marquee/license` package,
which ships here as an **inert community stub**: licensing and seat enforcement
are permanently **off**, so the open edition runs unlimited and unrestricted. The
commercial edition swaps in the real implementation behind the identical
interface.

## Trademarks

The Release Flight name and logo are trademarks and are **not** covered by the
AGPL grant. You may run and fork the code under the AGPL, but please don't use the
Release Flight name or logo in a way that implies endorsement or that your fork is
the official product. Rename your fork if you redistribute it.

## Questions

Licensing questions: **hello@releaseflight.com** (or open a discussion for
non-sensitive questions).
