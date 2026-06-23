"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, Loader2, Cloud } from "lucide-react";
import { Card, Stamp, cn } from "@marquee/ui";
import { api } from "@/lib/apiClient";

/**
 * Live "I just connected an app — fetch everything from the store" UI.
 *
 * After ConnectAppWizard creates the App row, it redirects here with
 * `?sync=1`. This component runs three POSTs sequentially:
 *
 *   1. /metadata/fetch    — every locale, with field-level diff
 *   2. /screenshots/fetch — preserve upstream URLs, no byte download
 *   3. /previews/fetch    — iOS-only, App Preview videos / images
 *
 * Each step renders an editorial-paper progress card with a spinner →
 * checkmark transition. Failures surface a warning Stamp with the actual
 * message so the user knows whether to re-trigger or check credentials.
 *
 * When all three complete, the component invokes `router.refresh()` so
 * the surrounding tab data re-fetches and the freshly-pulled records
 * appear without a hard reload.
 */

type StepStatus = "pending" | "running" | "success" | "failure" | "skipped";

interface Step {
  id: "metadata" | "screenshots" | "previews";
  label: string;
  description: string;
  status: StepStatus;
  message?: string;
  count?: number;
}

const INITIAL_STEPS: Step[] = [
  {
    id: "metadata",
    label: "Metadata",
    description: "Pull every localised title, subtitle, description from the store.",
    status: "pending",
  },
  {
    id: "screenshots",
    label: "Screenshots",
    description: "Index every device size, every locale. Keep CDN URLs — no byte download.",
    status: "pending",
  },
  {
    id: "previews",
    label: "App Previews",
    description: "Trailer videos by locale + device (iOS only — skipped for Android).",
    status: "pending",
  },
];

interface Props {
  appId: string;
  platform: "IOS" | "ANDROID";
}

export function AppSyncIndicator({ appId, platform }: Props): JSX.Element {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function runStep<T>(
      id: Step["id"],
      path: string,
      summarise: (data: T) => string,
    ): Promise<void> {
      setSteps((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: "running" } : s)),
      );
      const res = await api<T>(path, { method: "POST" });
      if (cancelled) return;
      if (res.ok) {
        setSteps((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, status: "success", message: summarise(res.data) } : s,
          ),
        );
      } else {
        setSteps((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, status: "failure", message: res.message } : s,
          ),
        );
      }
    }

    async function runAll(): Promise<void> {
      await runStep<{ locales: number }>(
        "metadata",
        `/api/v1/apps/${appId}/metadata/fetch`,
        (d) =>
          `${d.locales.toString()} locale${d.locales === 1 ? "" : "s"} synced from the store`,
      );
      if (cancelled) return;

      await runStep<{ count: number; displayTypes?: string[] }>(
        "screenshots",
        `/api/v1/apps/${appId}/screenshots/fetch`,
        (d) =>
          d.count === 0
            ? "Indexed — no screenshots on the store yet"
            : `${d.count.toString()} screenshot${d.count === 1 ? "" : "s"} indexed across ${(d.displayTypes?.length ?? 0).toString()} device types`,
      );
      if (cancelled) return;

      if (platform === "IOS") {
        await runStep<{ count: number; previewTypes?: string[] }>(
          "previews",
          `/api/v1/apps/${appId}/previews/fetch`,
          (d) =>
            d.count === 0
              ? "Indexed — no app previews on the store yet"
              : `${d.count.toString()} preview${d.count === 1 ? "" : "s"} indexed`,
        );
      } else {
        setSteps((prev) =>
          prev.map((s) =>
            s.id === "previews"
              ? { ...s, status: "skipped", message: "Previews are iOS-only." }
              : s,
          ),
        );
      }
      if (cancelled) return;

      setDone(true);
      router.refresh();
    }

    void runAll();
    return () => {
      cancelled = true;
    };
  }, [appId, platform, router]);

  const allOk = steps.every((s) => s.status === "success" || s.status === "skipped");
  const anyFailed = steps.some((s) => s.status === "failure");

  return (
    <Card className="overflow-hidden p-0">
      <header className="flex items-center justify-between border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Cloud size={14} className="text-[var(--ink-tertiary)]" aria-hidden />
          <h3
            className="font-display text-[14px] tracking-[-0.01em]"
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            Syncing from {platform === "IOS" ? "App Store Connect" : "Google Play Console"}
          </h3>
        </div>
        {done && allOk && (
          <Stamp variant="success">Connected</Stamp>
        )}
        {done && anyFailed && (
          <Stamp variant="warning">Partial</Stamp>
        )}
      </header>

      <ol className="divide-y-[0.5px] divide-[var(--stroke-default)]">
        {steps.map((step, i) => (
          <StepRow key={step.id} step={step} index={i} />
        ))}
      </ol>

      {done && (
        <footer className="border-t-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          {allOk
            ? "All assets ready · scroll down to view metadata, screenshots, previews"
            : "Some steps failed — open the relevant tab to retry"}
        </footer>
      )}
    </Card>
  );
}

function StepRow({ step, index }: { step: Step; index: number }): JSX.Element {
  return (
    <li className="flex items-start gap-4 px-5 py-3.5">
      <div className="mt-0.5">
        <StepIcon status={step.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)] tabular-nums"
          >
            0{(index + 1).toString()}
          </span>
          <h4
            className={cn(
              "font-display text-[14px] tracking-[-0.005em]",
              step.status === "running" && "text-[var(--ink-primary)]",
              step.status === "success" && "text-[var(--ink-primary)]",
              step.status === "pending" && "text-[var(--ink-secondary)]",
              step.status === "skipped" && "text-[var(--ink-tertiary)]",
              step.status === "failure" && "text-[var(--status-danger)]",
            )}
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            {step.label}
          </h4>
        </div>
        <p
          className={cn(
            "mt-0.5 font-body text-[12px] leading-[1.5]",
            step.status === "failure" ? "text-[var(--status-danger)]" : "text-[var(--ink-secondary)]",
          )}
        >
          {step.message ?? step.description}
        </p>
      </div>
    </li>
  );
}

function StepIcon({ status }: { status: StepStatus }): JSX.Element {
  if (status === "running")
    return <Loader2 size={16} className="animate-spin text-[var(--signal)]" aria-label="Running" />;
  if (status === "success")
    return <CheckCircle2 size={16} className="text-[var(--status-success)]" aria-label="Done" />;
  if (status === "failure")
    return <AlertTriangle size={16} className="text-[var(--status-danger)]" aria-label="Failed" />;
  if (status === "skipped")
    return (
      <span
        aria-label="Skipped"
        className="block h-2 w-2 translate-y-[7px] rounded-full bg-[var(--ink-quaternary)]"
      />
    );
  return (
    <span
      aria-label="Pending"
      className="block h-3.5 w-3.5 rounded-full border-[1.5px] border-[var(--stroke-strong)]"
    />
  );
}
