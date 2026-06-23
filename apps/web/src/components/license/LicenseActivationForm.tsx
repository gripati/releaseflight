"use client";

/**
 * LicenseActivationForm — OWNER-only form for sealed-distribution license
 * activation and transfer.
 *
 * Features:
 *   • "Activate" — POST /api/v1/license/activate
 *   • "Transfer" — POST /api/v1/license/transfer (moves license from old machine)
 *   • Shows result.message on failure, grouped by known error codes.
 *   • Shows a success state on ok=true.
 *   • Non-OWNER viewers see a read-only note instead.
 *
 * Error code labels follow the activate/transfer API return shapes.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, AlertTriangle, ArrowRightLeft } from "lucide-react";
import { Button, Card, Input, Label, Spinner } from "@marquee/ui";
import { api } from "@/lib/apiClient";

// ---- Types ------------------------------------------------------------------

interface ActivateResult {
  ok: boolean;
  code?: string;
  message?: string;
}

// ---- Error code → human label -----------------------------------------------

const ERROR_LABELS: Record<string, string> = {
  SEAT_TAKEN:
    'This license seat is already held by another machine. Use "Transfer" below to move it here, or contact support.',
  INVALID_KEY: "The license key is not recognised. Check for typos or contact support.",
  EMAIL_MISMATCH:
    "The email address does not match the license record. Use the email you purchased with.",
  OFFLINE:
    "Could not reach the license server. Make sure this machine has internet access, then retry.",
  NO_SERVER:
    "License server address is not configured. Contact your administrator.",
};

function errorLabel(code: string | undefined, fallback: string | undefined): string {
  if (code && ERROR_LABELS[code]) return ERROR_LABELS[code];
  return fallback ?? "Activation failed. Please try again or contact support.";
}

// ---- Component --------------------------------------------------------------

interface Props {
  isOwner: boolean;
}

export function LicenseActivationForm({ isOwner }: Props): JSX.Element {
  const [licenseKey, setLicenseKey] = useState("");
  const [email, setEmail] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ action: "activate" | "transfer" } | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!isOwner) {
    return (
      <p className="font-body text-[13px] text-[var(--ink-secondary)]">
        Only workspace Owners can activate or transfer a license. Contact your workspace Owner to
        update the license.
      </p>
    );
  }

  if (success) {
    return (
      <div className="flex items-start gap-3 rounded-[var(--radius)] border border-[var(--status-success)]/40 bg-[var(--status-success-tint)] p-4">
        <CheckCircle2
          size={18}
          className="mt-0.5 shrink-0 text-[var(--status-success)]"
          aria-hidden
        />
        <div>
          <p className="font-body text-[14px] font-semibold text-[var(--status-success)]">
            {success.action === "activate" ? "License activated" : "License transferred"}
          </p>
          <p className="mt-1 font-body text-[13px] text-[var(--ink-secondary)]">
            {success.action === "activate"
              ? "This installation is now fully licensed."
              : "The license has been moved to this machine."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => {
              setSuccess(null);
              setError(null);
              setLicenseKey("");
              setEmail("");
              setDeviceLabel("");
            }}
          >
            Activate a different key
          </Button>
        </div>
      </div>
    );
  }

  function submit(action: "activate" | "transfer"): void {
    setError(null);
    startTransition(async () => {
      const path =
        action === "activate"
          ? "/api/v1/license/activate"
          : "/api/v1/license/transfer";

      const res = await api<ActivateResult>(path, {
        method: "POST",
        body: {
          licenseKey,
          email,
          ...(deviceLabel.trim() ? { deviceLabel: deviceLabel.trim() } : {}),
        },
      });

      if (!res.ok) {
        setError(errorLabel(res.code, res.message));
        return;
      }

      if (!res.data.ok) {
        setError(errorLabel(res.data.code, res.data.message));
        return;
      }

      setSuccess({ action });
    });
  }

  return (
    <div className="space-y-5">
      {/* Error banner */}
      {error !== null && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[var(--radius)] border border-[var(--status-danger)]/40 bg-[var(--status-danger-tint)] px-4 py-3"
        >
          <AlertTriangle
            size={14}
            className="mt-0.5 shrink-0 text-[var(--status-danger)]"
            aria-hidden
          />
          <p className="font-body text-[13px] text-[var(--status-danger)]">{error}</p>
        </div>
      )}

      {/* Form fields */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="laf-key">License key</Label>
          <Input
            id="laf-key"
            type="text"
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            disabled={isPending}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="laf-email">Email address</Label>
          <Input
            id="laf-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={isPending}
            autoComplete="email"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="laf-device">
            Device label{" "}
            <span className="font-normal text-[var(--ink-tertiary)]">(optional)</span>
          </Label>
          <Input
            id="laf-device"
            type="text"
            placeholder="e.g. Mac Studio — CI server"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            disabled={isPending}
            autoComplete="off"
          />
          <p className="font-body text-[11px] text-[var(--ink-tertiary)]">
            Helps you identify this machine on the license dashboard.
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          variant="primary"
          size="md"
          disabled={isPending || !licenseKey.trim() || !email.trim()}
          onClick={() => submit("activate")}
        >
          {isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
          {isPending ? "Activating…" : "Activate"}
        </Button>

        <Button
          variant="secondary"
          size="md"
          disabled={isPending || !licenseKey.trim() || !email.trim()}
          onClick={() => submit("transfer")}
          title="Use this when the license is already bound to another machine and you want to move it to this one."
        >
          <ArrowRightLeft size={13} aria-hidden />
          Move license to this machine
        </Button>
      </div>

      {/* Transfer explanation */}
      <Card className="bg-[var(--surface-tinted)] p-3">
        <p className="font-body text-[12px] text-[var(--ink-secondary)]">
          <strong className="font-semibold text-[var(--ink-primary)]">
            Already activated elsewhere?
          </strong>{" "}
          If your license is bound to another machine (e.g., a decommissioned CI server),
          click <em>Move license to this machine</em>. This will release the old seat and
          re-bind the license to the current installation.
        </p>
      </Card>
    </div>
  );
}
