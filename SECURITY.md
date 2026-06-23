# Security Policy

Release Flight handles store credentials and signing material, so we take
security seriously and welcome responsible disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via either:

- GitHub's **[private vulnerability reporting](https://github.com/gripati/releaseflight/security/advisories/new)**
  (Security → Report a vulnerability), or
- email **security@releaseflight.com**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if possible),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge reports within **72 hours** and to keep you updated as we
investigate and fix. Please give us a reasonable window to ship a fix before any
public disclosure; we're happy to credit you.

## Scope

In scope: the code in this repository (the open community edition). The hosted
service and commercial components are covered separately — for those, email the
same address.

## Hardening baseline

Tenant isolation (Postgres RLS), AES-256-GCM secrets-at-rest, per-request CSP
with nonces, SSRF guards, and CSRF protection are treated as **invariants**. A
report showing any of these can be bypassed is especially valuable.
