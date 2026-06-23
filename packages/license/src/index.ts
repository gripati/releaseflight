/**
 * @marquee/license — COMMUNITY EDITION (open-source stub).
 *
 * Release Flight is open-core. This package is the COMMUNITY stub: every export
 * is an inert no-op so the open self-hosted edition builds and runs with all
 * seat/billing/licensing gates permanently OFF (unlimited seats, never frozen,
 * no activation server).
 *
 * The real implementation — online single-seat activation, Ed25519 token
 * verification, device fingerprinting, Polar-driven seat caps and the read-only
 * billing freeze — is a COMMERCIAL component of the hosted/licensed product and
 * is NOT part of this open-source repository. It is swapped in (same package
 * name, same surface) only in the proprietary build.
 *
 * Want the managed, no-setup, licensed product? → https://releaseflight.com
 *
 * Keep this file's PUBLIC SURFACE identical to the commercial package so the two
 * are drop-in interchangeable. Open code must only ever depend on this surface.
 */

// ── Types (must match the commercial package exactly) ────────────────────────

export type LicenseState =
  | "valid"
  | "grace"
  | "needs_activation"
  | "expired"
  | "fingerprint_mismatch"
  | "invalid";

export type BillingState = "active" | "past_due" | "grace" | "suspended" | "seats_exceeded";

export interface Verdict {
  state: LicenseState;
  ok: boolean;
  withinGrace: boolean;
  entitlements: Record<string, unknown>;
  plan: string | null;
  notAfter: number | null;
  graceUntil: number | null;
  secondsUntilExpiry: number | null;
  memberSeats: number | null;
  billingState: BillingState;
  reason: string;
}

export interface BillingEntitlements {
  /** Member-seat cap (null = unlimited / not enforced). Always null in community. */
  memberSeats: number | null;
  /** True only when a positive cap is present. Always false in community. */
  seatsEnforced: boolean;
  billingState: BillingState;
  currentPeriodEnd: number | null;
  manageBillingUrl: string | null;
}

export interface InitResult {
  enforced: boolean;
  verdict: Verdict | null;
}

export interface ActivateInput {
  licenseKey: string;
  email: string;
  deviceLabel?: string | undefined;
}

export interface ActivateOutcome {
  ok: boolean;
  code?: string;
  message?: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Community config: enforcement is permanently OFF. The commercial package reads
 * this from MARQUEE_LICENSE_* env; here it is a hard-coded inert object.
 */
export const licenseConfig = {
  /** Always false in community — every gate below short-circuits on this. */
  enforcement: false as boolean,
  hardStop: false as boolean,
  appVersion: "community",
  serverUrl: "",
} as const;

const COMMUNITY_MESSAGE =
  "Licensing & seat management are part of the commercial Release Flight edition. " +
  "The open-source edition runs unlimited and unrestricted. See https://releaseflight.com";

// ── Boot / status ──────────────────────────────────────────────────────────

/** Boot-time init — a complete no-op in the community edition. */
export function initLicense(
  _log: (msg: string, extra?: unknown) => void = () => {
    /* no-op */
  },
): InitResult {
  return { enforced: false, verdict: null };
}

/** UI verdict — always null in community (no nag banner, no re-activation). */
export function getLicenseStatus(): Verdict | null {
  return null;
}

/**
 * Server-side billing/seat entitlements — inert community defaults: unlimited
 * seats, never enforced, billing always "active". This is what makes every
 * seat gate and the read-only freeze a no-op in the open edition.
 */
export function getEntitlements(): BillingEntitlements {
  return {
    memberSeats: null,
    seatsEnforced: false,
    billingState: "active",
    currentPeriodEnd: null,
    manageBillingUrl: null,
  };
}

/** Code-protection key — never present in the open edition. */
export function getContentKey(): Buffer | null {
  return null;
}

// ── Activation (commercial-only) ─────────────────────────────────────────────

export async function activateLicense(_input: ActivateInput): Promise<ActivateOutcome> {
  return { ok: false, code: "COMMUNITY_EDITION", message: COMMUNITY_MESSAGE };
}

export async function transferLicense(_input: ActivateInput): Promise<ActivateOutcome> {
  return { ok: false, code: "COMMUNITY_EDITION", message: COMMUNITY_MESSAGE };
}

// ── Internals kept for surface-compatibility (inert in community) ────────────

export function verifyCachedToken(): Verdict {
  return {
    state: "needs_activation",
    ok: true,
    withinGrace: false,
    entitlements: {},
    plan: null,
    notAfter: null,
    graceUntil: null,
    secondsUntilExpiry: null,
    memberSeats: null,
    billingState: "active",
    reason: "community edition — licensing disabled",
  };
}

export function computeFingerprintComponents(): string[] {
  return [];
}

export async function heartbeatNow(): Promise<void> {
  /* no-op */
}

export async function refreshNow(): Promise<void> {
  /* no-op */
}

export function unwrapContentKey(): Buffer | null {
  return null;
}
