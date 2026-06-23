"use client";

/**
 * LicenseBanner — top-of-shell nag for sealed-distribution installs. Covers BOTH
 * the offline-license states (grace / needs_activation / expired / invalid /
 * fingerprint_mismatch) AND the Polar subscription/billing states
 * (past_due / grace / suspended / seats_exceeded).
 *
 * SHOW NOTHING when: enforcement is off, status is null, or the install is
 * healthy (license ok, not in grace) AND billing is "active".
 *
 * Dismissible per-session (sessionStorage), EXCEPT for suspended/grace which are
 * non-dismissible so a frozen/expiring instance can't be silently ignored.
 * No inline <script> — strict-CSP safe.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CreditCard, RefreshCw, X } from "lucide-react";
import { Button, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";

type LicenseState =
  | "valid"
  | "grace"
  | "needs_activation"
  | "expired"
  | "fingerprint_mismatch"
  | "invalid";

type BillingState = "active" | "past_due" | "grace" | "suspended" | "seats_exceeded";

interface Verdict {
  state: LicenseState;
  ok: boolean;
  withinGrace: boolean;
  entitlements: Record<string, unknown>;
  plan: string | null;
  notAfter: number | null;
  graceUntil: number | null;
  secondsUntilExpiry: number | null;
  reason: string;
}

interface Billing {
  memberSeats: number | null;
  seatsEnforced: boolean;
  billingState: BillingState;
  currentPeriodEnd: number | null;
  manageBillingUrl: string | null;
}

interface StatusResponse {
  enforced: boolean;
  status: Verdict | null;
  billing: Billing | null;
}

const DISMISS_KEY = "marquee_license_banner_dismissed";

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function dismiss(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore */
  }
}

function daysLeft(secondsUntilExpiry: number | null): string | null {
  if (secondsUntilExpiry === null) return null;
  const days = Math.ceil(secondsUntilExpiry / 86400);
  if (days <= 0) return null;
  return days === 1 ? "1 day" : `${days.toString()} days`;
}

const LICENSE_MESSAGE: Record<Exclude<LicenseState, "valid" | "grace">, string> = {
  needs_activation:
    "This installation is not activated. Activate your license to continue using Release Flight.",
  expired: "Your Release Flight license has expired. Please renew or re-activate.",
  fingerprint_mismatch:
    "License fingerprint mismatch — this may be a different machine. Transfer your license or contact support.",
  invalid: "Your Release Flight license is invalid. Please re-activate or contact support.",
};

interface Display {
  tone: "warning" | "danger";
  title: string;
  message: string;
  /** Show the external "Manage billing" CTA (Polar Customer Portal). */
  manageBilling: boolean;
  /** Show the in-app License settings link. */
  licenseSettings: boolean;
  /** Block per-session dismissal (suspended / billing-grace are sticky). */
  sticky: boolean;
}

/** Resolve what to show; billing takes priority over soft license-grace. */
function resolveDisplay(status: Verdict, billing: Billing | null): Display | null {
  const billingState: BillingState = billing?.billingState ?? "active";

  if (billingState === "suspended") {
    return {
      tone: "danger",
      title: "Subscription on hold",
      message:
        "Your workspace is read-only until billing resumes. Update your payment method to continue.",
      manageBilling: true,
      licenseSettings: false,
      sticky: true,
    };
  }
  if (!status.ok) {
    return {
      tone: "danger",
      title: "License issue",
      message: LICENSE_MESSAGE[status.state as Exclude<LicenseState, "valid" | "grace">] ?? status.reason,
      manageBilling: false,
      licenseSettings: true,
      sticky: status.state === "expired",
    };
  }
  if (billingState === "past_due") {
    return {
      tone: "warning",
      title: "Payment failed",
      message: "We couldn't process your last payment — update your billing method to avoid interruption.",
      manageBilling: true,
      licenseSettings: false,
      sticky: false,
    };
  }
  if (billingState === "grace") {
    const left = daysLeft(status.secondsUntilExpiry);
    return {
      tone: "warning",
      title: "Payment overdue",
      message: left
        ? `Update billing to avoid a pause — access pauses in ${left}.`
        : "Update billing to avoid your workspace being paused.",
      manageBilling: true,
      licenseSettings: false,
      sticky: true,
    };
  }
  if (billingState === "seats_exceeded") {
    return {
      tone: "warning",
      title: "Over seat limit",
      message:
        "You have more active members than your plan allows. Add seats or remove members to stay compliant.",
      manageBilling: true,
      licenseSettings: false,
      sticky: false,
    };
  }
  if (status.withinGrace) {
    const left = daysLeft(status.secondsUntilExpiry);
    return {
      tone: "warning",
      title: "License re-verification due",
      message: left
        ? `Your Release Flight license will re-verify soon — connect to the internet. Expires in ${left}.`
        : "Your Release Flight license will re-verify soon — connect to the internet.",
      manageBilling: false,
      licenseSettings: false,
      sticky: false,
    };
  }
  return null;
}

interface Props {
  /** Tenant slug used to build the link to the license settings page. */
  tenantSlug: string;
}

export function LicenseBanner({ tenantSlug }: Props): JSX.Element | null {
  const [display, setDisplay] = useState<Display | null>(null);
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [shouldShow, setShouldShow] = useState<boolean | null>(null);

  useEffect(() => {
    void api<StatusResponse>("/api/v1/license/status").then((res) => {
      if (!res.ok) {
        setShouldShow(false);
        return;
      }
      const { enforced, status, billing } = res.data;
      if (!enforced || status === null) {
        setShouldShow(false);
        return;
      }
      const d = resolveDisplay(status, billing);
      if (!d) {
        setShouldShow(false);
        return;
      }
      if (!d.sticky && isDismissed()) {
        setDismissed(true);
        return;
      }
      setDisplay(d);
      setManageUrl(billing?.manageBillingUrl ?? null);
      setShouldShow(true);
    });
  }, []);

  if (dismissed || shouldShow !== true || display === null) return null;

  const isWarning = display.tone === "warning";
  const settingsHref = `/t/${tenantSlug}/settings/license`;

  const handleDismiss = (): void => {
    dismiss();
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius)] border px-4 py-3",
        "font-body text-[13px]",
        isWarning
          ? "border-[var(--status-warning)]/40 bg-[var(--status-warning-tint)] text-[var(--status-warning)]"
          : "border-[var(--status-danger)]/40 bg-[var(--status-danger-tint)] text-[var(--status-danger)]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
          isWarning ? "bg-[var(--status-warning)]/15" : "bg-[var(--status-danger)]/15",
        )}
        aria-hidden
      >
        {isWarning ? <RefreshCw size={11} /> : <AlertTriangle size={11} />}
      </span>

      <div className="min-w-0 flex-1">
        <p>
          <strong className="font-semibold">{display.title}.</strong> {display.message}
        </p>
      </div>

      {display.manageBilling && manageUrl && (
        <a
          href={manageUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] px-3 py-1",
            "font-body text-[12px] font-medium text-white transition-opacity hover:opacity-90",
            isWarning ? "bg-[var(--status-warning)]" : "bg-[var(--status-danger)]",
          )}
        >
          <CreditCard size={12} aria-hidden />
          Manage billing
        </a>
      )}

      {display.licenseSettings && (
        <Link
          href={settingsHref}
          className={cn(
            "shrink-0 rounded-[var(--radius-sm)] border border-[var(--status-danger)]/30",
            "bg-[var(--status-danger)] px-3 py-1 font-body text-[12px] font-medium text-white",
            "transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-[var(--status-danger)] focus-visible:ring-offset-2",
          )}
        >
          License settings
        </Link>
      )}

      {!display.sticky && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 shrink-0 rounded-full",
            isWarning ? "hover:bg-[var(--status-warning)]/20" : "hover:bg-[var(--status-danger)]/20",
          )}
          onClick={handleDismiss}
          aria-label="Dismiss license banner"
        >
          <X size={12} aria-hidden />
        </Button>
      )}
    </div>
  );
}
