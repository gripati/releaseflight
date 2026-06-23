"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCcw,
  Rocket,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button, Card, Spinner, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import { ConfirmDialog } from "@/components/feedback/ConfirmDialog";

interface AppleBuild {
  id: string;
  version: string;
  buildNumber: string;
  uploadedDate: string;
  state: string;
  usesNonExemptEncryption: boolean | null;
}

interface IosResponse {
  platform: "IOS";
  builds: AppleBuild[];
}

interface Props {
  appId: string;
  versionId: string | null;
  versionString: string | null;
  status: string | null;
  localeCount: number;
  screenshotCount: number;
  discoveredScreenshotTypes: string[];
}

function stateStamp(state: string): "success" | "info" | "danger" | "warning" {
  if (state === "VALID") return "success";
  if (state === "PROCESSING") return "info";
  if (state === "INVALID" || state === "FAILED") return "danger";
  return "warning";
}

export function SubmissionPanel(props: Props): JSX.Element {
  const router = useRouter();
  const [builds, setBuilds] = useState<AppleBuild[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const [refreshing, refresh] = useTransition();
  const [submitting, startSubmit] = useTransition();
  const [canceling, startCancel] = useTransition();
  const [compliancePending, setCompliancePending] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  function reload(): void {
    refresh(() => {
      void (async () => {
        setLoadError(null);
        try {
          const res = await api<IosResponse>(`/api/v1/apps/${props.appId}/builds`);
          if (res.ok && res.data.platform === "IOS") {
            setBuilds(res.data.builds);
            setSelectedBuildId(
              (cur) => cur ?? res.data.builds.find((b) => b.state === "VALID")?.id ?? null,
            );
          } else {
            // Never leave builds===null after a completed request, or the panel
            // spins forever. Surface the error with a Retry affordance.
            setBuilds([]);
            const msg = res.ok ? "Unexpected response from the builds API." : res.message;
            setLoadError(msg);
            if (!res.ok) toast.error("Couldn't load builds", { description: msg });
          }
        } catch (e) {
          setBuilds([]);
          const msg = e instanceof Error ? e.message : String(e);
          setLoadError(msg);
          toast.error("Couldn't load builds", { description: msg });
        }
      })();
    });
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.appId]);

  const selectedBuild = builds?.find((b) => b.id === selectedBuildId) ?? null;
  const complianceMissing = selectedBuild?.usesNonExemptEncryption === null;
  const complianceOk = selectedBuild != null && selectedBuild.usesNonExemptEncryption !== null;

  function declareCompliance(uses: boolean): void {
    if (!selectedBuildId) return;
    setCompliancePending(true);
    void (async () => {
      const res = await api(`/api/v1/apps/${props.appId}/builds`, {
        method: "PATCH",
        body: { buildId: selectedBuildId, usesNonExemptEncryption: uses },
      });
      setCompliancePending(false);
      if (res.ok) {
        toast.success("Export compliance declared");
        reload();
      } else {
        toast.error("Couldn't set compliance", { description: res.message });
      }
    })();
  }

  function cancelOpen(): void {
    startCancel(() => {
      void (async () => {
        const res = await api<{ canceled: boolean }>(
          `/api/v1/apps/${props.appId}/submit-for-review`,
          {
            method: "DELETE",
          },
        );
        if (res.ok) {
          toast.success(
            res.data.canceled ? "Canceled the open submission" : "No open submission to cancel",
          );
        } else {
          toast.error("Couldn't cancel", { description: res.message });
        }
      })();
    });
  }

  function doSubmit(): void {
    setConfirmSubmit(false);
    startSubmit(() => {
      void (async () => {
        const t = toast.loading("Submitting for review…", {
          description: "Apple may take 24-48 hours for the initial response.",
        });
        const res = await api<{ submissionId: string }>(
          `/api/v1/apps/${props.appId}/submit-for-review`,
          {
            method: "POST",
            body: { buildId: selectedBuildId },
          },
        );
        if (!res.ok) {
          toast.error("Submission failed", { id: t, description: res.message });
          return;
        }
        toast.success("Submitted for review", {
          id: t,
          description: `Submission ${res.data.submissionId.slice(0, 8)}…`,
        });
        router.refresh();
      })();
    });
  }

  // HARD gates — the things Apple actually requires.
  const hardChecks: { ok: boolean; label: string; detail: string }[] = [
    {
      ok: Boolean(props.versionId),
      label: "App Store version",
      detail: props.versionId
        ? `v${props.versionString ?? "?"}`
        : "no editable version — pull metadata first",
    },
    {
      ok: Boolean(selectedBuildId),
      label: "Build selected",
      detail: selectedBuild
        ? `v${selectedBuild.version || "?"} (#${selectedBuild.buildNumber})`
        : "pick a VALID build below",
    },
    {
      ok: complianceOk,
      label: "Export compliance",
      detail: complianceMissing
        ? "declare encryption below"
        : complianceOk
          ? "declared"
          : "select a build first",
    },
  ];
  // SOFT — surfaced as warnings but don't block (Apple validates assets itself,
  // and metadata may have been edited directly in App Store Connect).
  const softChecks: { ok: boolean; label: string; detail: string }[] = [
    {
      ok: props.localeCount > 0,
      label: "Metadata localized",
      detail: `${props.localeCount.toString()} locales saved`,
    },
    {
      ok: props.discoveredScreenshotTypes.length > 0,
      label: "Screenshots",
      detail: `${props.screenshotCount.toString()} images`,
    },
  ];
  const canSubmit = Boolean(props.versionId) && Boolean(selectedBuildId) && complianceOk;

  return (
    <div className="page-loaded space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
            Apple · submit for review · {props.status ?? "no status"}
            {props.versionString ? ` · v${props.versionString}` : ""}
          </p>
          <h2
            className="font-display mt-1 text-2xl tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            Release
          </h2>
        </div>
        <Button variant="ghost" size="md" onClick={reload} disabled={refreshing}>
          {refreshing ? <Spinner size={12} /> : <RefreshCcw size={14} />} Refresh builds
        </Button>
      </div>

      <Card>
        <h3 className="mb-3 font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Pre-flight
        </h3>
        <ul className="space-y-2">
          {hardChecks.map((c) => (
            <li key={c.label} className="flex items-center gap-3">
              {c.ok ? (
                <CheckCircle2 size={14} className="text-[var(--status-success)]" />
              ) : (
                <XCircle size={14} className="text-[var(--status-danger)]" />
              )}
              <span className="font-body text-[13px]">{c.label}</span>
              <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">— {c.detail}</span>
            </li>
          ))}
          {softChecks.map((c) => (
            <li key={c.label} className="flex items-center gap-3 opacity-80">
              {c.ok ? (
                <CheckCircle2 size={14} className="text-[var(--status-success)]" />
              ) : (
                <AlertTriangle size={14} className="text-[var(--status-warning)]" />
              )}
              <span className="font-body text-[13px]">{c.label}</span>
              <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                — {c.detail} {c.ok ? "" : "(optional)"}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Export-compliance one-click resolve (Apple's most common blocker). */}
      {complianceMissing && (
        <Card className="border-[var(--status-warning)]">
          <div className="flex items-start gap-2.5">
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--status-warning)]" />
            <div className="flex-1">
              <h3 className="font-body text-[13px] font-medium text-[var(--ink-primary)]">
                Declare export compliance for the selected build
              </h3>
              <p className="mt-0.5 text-[12px] text-[var(--ink-secondary)]">
                Does this build use encryption beyond Apple/HTTPS standard exemptions? Most apps
                don't.
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => declareCompliance(false)}
                  disabled={compliancePending}
                >
                  {compliancePending ? <Spinner size={12} /> : null} No (standard / exempt)
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => declareCompliance(true)}
                  disabled={compliancePending}
                >
                  Yes, it does
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <h3 className="mb-3 font-mono text-[10px] tracking-[0.12em] text-[var(--ink-tertiary)] uppercase">
          Select a build (required)
        </h3>
        {builds === null ? (
          <div className="flex items-center gap-2">
            <Spinner size={12} />
            <span className="font-body text-[12px] text-[var(--ink-tertiary)]">
              Loading builds…
            </span>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="font-body text-[13px] text-[var(--status-danger)]">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={reload} disabled={refreshing}>
              {refreshing ? <Spinner size={12} /> : <RefreshCcw size={13} />} Retry
            </Button>
          </div>
        ) : builds.length === 0 ? (
          <p className="font-body text-[13px] text-[var(--ink-secondary)]">
            No builds yet. Apple takes a few minutes after an upload — refresh in a moment, or
            deploy a build to App Store from the <strong>Deploy</strong> tab.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {builds.map((b) => {
              const isSelected = selectedBuildId === b.id;
              const selectable = b.state === "VALID";
              return (
                <li
                  key={b.id}
                  onClick={() => selectable && setSelectedBuildId(b.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-[var(--radius)] border px-3 py-2.5 transition-colors",
                    selectable ? "cursor-pointer" : "cursor-not-allowed opacity-55",
                    isSelected
                      ? "border-[var(--signal)] bg-[var(--signal-tint)]"
                      : "border-[var(--stroke-default)] hover:bg-[var(--surface-tinted)]",
                  )}
                >
                  {/* radio — the chosen build is unmistakable */}
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      isSelected ? "border-[var(--signal)]" : "border-[var(--stroke-strong)]",
                    )}
                  >
                    {isSelected && <span className="h-2 w-2 rounded-full bg-[var(--signal)]" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-medium text-[var(--ink-primary)]">
                        v{b.version || "?"} (#{b.buildNumber})
                      </span>
                      {isSelected && <Stamp variant="info">selected</Stamp>}
                    </div>
                    <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                      uploaded {new Date(b.uploadedDate).toLocaleString()}
                    </span>
                  </div>
                  {b.state === "VALID" && b.usesNonExemptEncryption === null && (
                    <Stamp variant="warning">missing compliance</Stamp>
                  )}
                  <Stamp variant={stateStamp(b.state)}>{b.state}</Stamp>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* What's actually going out — crystal-clear before the button. */}
      {selectedBuild && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--signal)] bg-[var(--signal-tint)] px-3.5 py-2.5">
          <Rocket size={14} className="text-[var(--signal)]" />
          <span className="text-[12px] text-[var(--ink-secondary)]">Submitting</span>
          <span className="font-mono text-[13px] font-medium text-[var(--ink-primary)]">
            v{props.versionString ?? (selectedBuild.version || "?")} (#{selectedBuild.buildNumber})
          </span>
          <span className="text-[11px] text-[var(--ink-tertiary)]">
            uploaded {new Date(selectedBuild.uploadedDate).toLocaleDateString()}
          </span>
          {!complianceOk && (
            <span className="text-[11px] text-[var(--status-warning)]">
              — declare export compliance first
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={cancelOpen}
          disabled={canceling}
          className="text-[11px] text-[var(--ink-tertiary)] underline decoration-dotted underline-offset-2 hover:text-[var(--ink-primary)]"
        >
          {canceling ? "Canceling…" : "Cancel open submission"}
        </button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setConfirmSubmit(true)}
          disabled={submitting || !canSubmit}
        >
          {submitting ? (
            <Spinner size={14} />
          ) : (
            <>
              <Rocket size={14} /> Submit for review
            </>
          )}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmSubmit}
        onClose={() => !submitting && setConfirmSubmit(false)}
        onConfirm={doSubmit}
        title="Submit this version for App Store review?"
        description={
          selectedBuild
            ? `Submitting v${props.versionString ?? (selectedBuild.version || "?")} with build #${selectedBuild.buildNumber} (uploaded ${new Date(selectedBuild.uploadedDate).toLocaleDateString()}). Apple requires manual cancellation in App Store Connect once submitted.`
            : "This cannot be undone via the API — Apple requires manual cancellation in App Store Connect."
        }
        confirmLabel="Submit"
        variant="warning"
        pending={submitting}
      />
    </div>
  );
}
