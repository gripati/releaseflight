"use client";

/**
 * Page-level state for the Astro autopilot. The provider lives at the
 * top of the /metadata page; both the top banner and the per-locale
 * proposals section subscribe to it via `useAstroAutopilot()`.
 *
 * Source of truth: the SERVER's merged view (`/aso/astro/latest`). The
 * server unions the last N completed analyze jobs per-locale so per-
 * locale re-runs don't wipe other locales. The provider holds that
 * merged snapshot in `data` and re-fetches whenever a job completes.
 *
 * Lifecycle:
 *   • mount → fetch `/aso/astro/latest`. If a job is in-flight, also
 *     start polling its progress.
 *   • runAnalyze(locale?) → enqueue (optionally locale-scoped),
 *     start polling job status, and re-fetch `/latest` on completion.
 *   • applyAutoDecay / applyLocaleSelection → mutate Apple-side, then
 *     re-fetch the merged snapshot so the new tracked keywords appear.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { toast } from "@/components/feedback/Toaster";
import type {
  AstroAnalyzeResponse,
  AstroApplyResponse,
  AstroJobSnapshot,
  AstroLatestSnapshot,
  AstroPhase,
  AstroRecommendByLocale,
  AstroSwapProposal,
} from "./types";

interface AstroAutopilotContextValue {
  /** True when the tenant has at least one active ASO_RESEARCH_MCP credential. */
  astroConfigured: boolean | null;
  /** Server-merged per-locale snapshot. Updated by the initial fetch
   *  and every time an analyze job completes. */
  data: AstroAnalyzeResponse | null;
  /** Latest job status (in-flight or last finished). Drives spinners. */
  job: AstroJobSnapshot | null;
  /** Coarse-grained banner phase derived from `job`. */
  phase: AstroPhase;
  /** Locale → "when did the currently-shown proposals come from". */
  perLocaleAnalyzedAt: Record<string, string>;
  /** Selected proposal indices per locale, exposed so both the banner
   *  and the per-locale section share a single source of truth. */
  selected: Record<string, Set<number>>;
  toggleProposal: (locale: string, idx: number) => void;
  setLocaleSelection: (locale: string, indices: Set<number>) => void;
  /** Look up proposals for a single locale — convenience wrapper. */
  proposalsForLocale: (locale: string) => AstroRecommendByLocale | null;
  /** True when the in-flight job is touching this locale (or all). */
  isLocaleAnalyzing: (locale: string) => boolean;
  /** Filter knobs the banner exposes — popularity floor + difficulty
   *  ceiling for the realistic-target shortlist. Forwarded to the
   *  analyze job. */
  minPopularity: number;
  maxDifficulty: number;
  setMinPopularity: (v: number) => void;
  setMaxDifficulty: (v: number) => void;
  /** Enqueue a fresh analyze run. Pass a locale to scope to a single
   *  locale (cheap re-run); omit to analyze every locale. */
  runAnalyze: (localeCode?: string) => Promise<void>;
  /** Apply every DECAY_AUTO proposal across every locale in one call. */
  applyAutoDecay: () => Promise<void>;
  /** Apply explicit pairs for a single locale. */
  applyLocaleSelection: (
    locale: string,
    pairs: { weakKeyword: string | null; strongKeyword: string }[],
  ) => Promise<AstroApplyResponse | null>;
  applyingAuto: boolean;
}

const AstroAutopilotContext = createContext<AstroAutopilotContextValue | null>(null);

export function useAstroAutopilot(): AstroAutopilotContextValue {
  const ctx = useContext(AstroAutopilotContext);
  if (!ctx) {
    throw new Error("useAstroAutopilot must be called inside <AstroAutopilotProvider>");
  }
  return ctx;
}

export function AstroAutopilotProvider({
  appId,
  children,
}: {
  appId: string;
  children: React.ReactNode;
}): JSX.Element {
  const router = useRouter();
  const [astroConfigured, setAstroConfigured] = useState<boolean | null>(null);
  const [data, setData] = useState<AstroAnalyzeResponse | null>(null);
  const [job, setJob] = useState<AstroJobSnapshot | null>(null);
  const [phase, setPhase] = useState<AstroPhase>("loading");
  const [selected, setSelected] = useState<Record<string, Set<number>>>({});
  const [perLocaleAnalyzedAt, setPerLocaleAnalyzedAt] = useState<Record<string, string>>({});
  const [applyingAuto, setApplyingAuto] = useState(false);
  // Realistic-target filter — popularity floor + difficulty ceiling.
  // Defaults match the server (25 / 60); the user can adjust per-run
  // via the banner controls.
  const [minPopularity, setMinPopularity] = useState(25);
  const [maxDifficulty, setMaxDifficulty] = useState(60);
  // Latest job id we're actively polling so the effect can cancel
  // cleanly when a fresh run is enqueued or the user navigates away.
  const activeJobIdRef = useRef<string | null>(null);

  // ── Apply a merged snapshot to local state ─────────────────────────
  const applyMergedSnapshot = useCallback((snap: AstroLatestSnapshot): void => {
    setJob(snap.job);
    setData(snap.merged);
    setPerLocaleAnalyzedAt(snap.perLocaleAnalyzedAt);

    // Pre-check every DECAY_AUTO proposal across all locales — same
    // behaviour as before, but driven by the merged view instead of
    // a single job result.
    if (snap.merged) {
      const preselected: Record<string, Set<number>> = {};
      for (const bucket of snap.merged.recommendationsByLocale) {
        const picks = new Set<number>();
        bucket.proposals.forEach((p, i) => {
          if (p.kind === "DECAY_AUTO") picks.add(i);
        });
        if (picks.size > 0) preselected[bucket.locale] = picks;
      }
      setSelected(preselected);
    }

    // Derive coarse phase from job.status for the banner.
    if (!snap.job) {
      setPhase(snap.merged ? "done" : "idle");
      return;
    }
    if (snap.job.status === "QUEUED") setPhase("queued");
    else if (snap.job.status === "RUNNING") setPhase("running");
    else if (snap.job.status === "COMPLETED") setPhase("done");
    else setPhase(snap.merged ? "done" : "idle");
  }, []);

  // ── Reusable "fetch /latest" wrapper ───────────────────────────────
  const reloadLatest = useCallback(async (): Promise<void> => {
    const res = await api<AstroLatestSnapshot>(`/api/v1/apps/${appId}/aso/astro/latest`);
    if (res.ok) applyMergedSnapshot(res.data);
  }, [appId, applyMergedSnapshot]);

  // ── Hydrate Astro state on mount ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const credRes = await api<{
        credentials: { kind: string; isActive: boolean }[];
      }>("/api/v1/credentials");
      if (cancelled) return;
      const has =
        credRes.ok &&
        credRes.data.credentials.some((c) => c.kind === "ASO_RESEARCH_MCP" && c.isActive);
      setAstroConfigured(has);
      if (!has) {
        setPhase("idle");
        return;
      }
      const latestRes = await api<AstroLatestSnapshot>(`/api/v1/apps/${appId}/aso/astro/latest`);
      if (cancelled) return;
      if (latestRes.ok) {
        applyMergedSnapshot(latestRes.data);
      } else {
        setPhase("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // ── In-flight job polling ──────────────────────────────────────────
  // We poll the job endpoint for progress updates while it's running.
  // On COMPLETED we re-fetch /latest to get the freshly merged view —
  // the job's `result` alone wouldn't include other locales' proposals
  // when this was a single-locale run.
  useEffect(() => {
    if (!job || (job.status !== "QUEUED" && job.status !== "RUNNING")) return;
    activeJobIdRef.current = job.id;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const res = await api<{
        id: string;
        status: AstroJobSnapshot["status"];
        progress: AstroJobSnapshot["progress"];
        result: AstroAnalyzeResponse | null;
        error: { code?: string; message?: string } | null;
        createdAt: string;
        finishedAt: string | null;
      }>(`/api/v1/jobs/${job.id}`);
      if (cancelled || activeJobIdRef.current !== job.id) return;
      if (!res.ok) {
        setTimeout(() => void tick(), 5000);
        return;
      }
      // Update job snapshot (status + progress) without touching `data`
      // — that's the merged view, refreshed only on completion.
      const targetLocales = job.targetLocales;
      setJob({
        id: res.data.id,
        status: res.data.status,
        progress: res.data.progress,
        result: null,
        error: res.data.error,
        createdAt: res.data.createdAt,
        finishedAt: res.data.finishedAt,
        targetLocales,
      });
      if (res.data.status === "QUEUED") setPhase("queued");
      else if (res.data.status === "RUNNING") setPhase("running");

      if (res.data.status === "COMPLETED") {
        // Pull the merged view so other locales' proposals are still
        // visible alongside the newly-refreshed slice.
        await reloadLatest();
        const completedResult = res.data.result;
        toast.success("Astro analysis complete", {
          description: completedResult
            ? `${completedResult.totals.proposals.toString()} proposals · ${completedResult.totals.autoSwaps.toString()} auto · ${completedResult.totals.opportunities.toString()} preview`
            : "Results ready.",
        });
        return;
      }
      if (res.data.status === "FAILED") {
        setPhase("idle");
        toast.error("Astro analysis failed", {
          description: res.data.error?.message ?? "Job failed",
        });
        return;
      }
      setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, reloadLatest]);

  // ── Actions ─────────────────────────────────────────────────────────
  const runAnalyze = useCallback(
    async (localeCode?: string): Promise<void> => {
      const res = await api<{
        jobId: string;
        status: string;
        reused: boolean;
        existingTargetLocales?: string[] | null;
        requestedLocales?: string[] | null;
      }>(`/api/v1/apps/${appId}/aso/astro/analyze`, {
        method: "POST",
        body: {
          // Locale filter — when set, the worker scopes the entire run
          // to that single locale (cheap; ~30s; saves AI tokens).
          ...(localeCode && { locales: [localeCode] }),
          // Forward the user's current filter knobs so the worker
          // applies them to the analyze job. Defaults match the
          // server's own defaults — we send them explicitly so the
          // request is self-describing for log review.
          minPopularity,
          maxDifficulty,
          enrichWithMetrics: true,
        },
      });
      if (!res.ok) {
        toast.error("Could not start Astro analysis", { description: res.message });
        return;
      }
      if (res.data.reused) {
        // Existing job in flight. Inform the user honestly about what it
        // covers vs. what they asked for so they're not surprised when
        // their per-locale click "doesn't seem to do anything new".
        const existing = res.data.existingTargetLocales ?? null;
        const existingLabel =
          existing === null
            ? "all locales"
            : existing.length <= 3
              ? existing.join(", ")
              : `${existing.slice(0, 2).join(", ")} +${(existing.length - 2).toString()}`;
        const covered =
          existing === null ||
          (localeCode != null && existing.includes(localeCode)) ||
          (!localeCode && existing.length === 0);
        if (covered) {
          toast(`An Astro analysis is already running (${existingLabel}) — picking it up.`);
        } else {
          toast(
            `An Astro analysis for ${existingLabel} is still running. Wait for it to finish before re-analyzing ${localeCode ?? "all locales"}.`,
          );
        }
      } else if (localeCode) {
        toast(`Astro analysis queued for ${localeCode}.`);
      } else {
        toast("Astro analysis queued — you can leave this page.");
      }
      // Seed the job state so the polling effect kicks in immediately.
      // When we re-used an existing job, derive its targetLocales from
      // the server response — otherwise mirror what we just requested.
      const serverTargets =
        res.data.reused && res.data.existingTargetLocales !== undefined
          ? res.data.existingTargetLocales
          : localeCode
            ? [localeCode]
            : null;
      setJob({
        id: res.data.jobId,
        status: (res.data.status as AstroJobSnapshot["status"]) ?? "QUEUED",
        progress: { current: 0, total: 1, step: "Queued" },
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        targetLocales: serverTargets,
      });
      setPhase("queued");
    },
    [appId, minPopularity, maxDifficulty],
  );

  const applyAutoDecay = useCallback(async (): Promise<void> => {
    if (!data) return;
    setApplyingAuto(true);
    const res = await api<AstroApplyResponse>(`/api/v1/apps/${appId}/aso/astro/apply`, {
      method: "POST",
      body: { mode: "auto" },
    });
    setApplyingAuto(false);
    if (!res.ok) {
      toast.error("Auto-apply failed", { description: res.message });
      return;
    }
    toast.success(`Auto-applied ${res.data.totalApplied.toString()} DECAY swaps`, {
      description: `${res.data.newTrackedKeywords.toString()} new tracked keywords created. Push to App Store when ready.`,
    });
    // Re-fetch the merged view — applied DECAY proposals are now
    // tracked keywords, so they shouldn't re-appear in subsequent
    // analyses. Until the next analyze runs we keep the data around
    // but auto-applied buckets get cleared visually by the row removal.
    await reloadLatest();
    router.refresh();
  }, [appId, data, router, reloadLatest]);

  const applyLocaleSelection = useCallback(
    async (
      locale: string,
      pairs: { weakKeyword: string | null; strongKeyword: string }[],
    ): Promise<AstroApplyResponse | null> => {
      if (pairs.length === 0) {
        toast("Pick at least one row first");
        return null;
      }
      const res = await api<AstroApplyResponse>(`/api/v1/apps/${appId}/aso/astro/apply`, {
        method: "POST",
        body: { mode: "selected", swapsByLocale: [{ locale, pairs }] },
      });
      if (!res.ok) {
        toast.error("Apply failed", { description: res.message });
        return null;
      }
      const applied = res.data.perLocale[0]?.applied ?? 0;
      toast.success(`${applied.toString()} swap${applied === 1 ? "" : "s"} applied for ${locale}`);
      // Drop applied rows from selection so the UI doesn't re-show them.
      setSelected((s) => ({ ...s, [locale]: new Set() }));
      router.refresh();
      return res.data;
    },
    [appId, router],
  );

  const toggleProposal = useCallback((locale: string, idx: number): void => {
    setSelected((s) => {
      const cur = new Set(s[locale] ?? []);
      if (cur.has(idx)) cur.delete(idx);
      else cur.add(idx);
      return { ...s, [locale]: cur };
    });
  }, []);

  const setLocaleSelection = useCallback((locale: string, indices: Set<number>): void => {
    setSelected((s) => ({ ...s, [locale]: indices }));
  }, []);

  const proposalsForLocale = useCallback(
    (locale: string): AstroRecommendByLocale | null => {
      if (!data) return null;
      return data.recommendationsByLocale.find((b) => b.locale === locale) ?? null;
    },
    [data],
  );

  // True when the in-flight job will produce a result for `locale`.
  // - In-flight + `targetLocales == null` → whole-app run; every locale matches.
  // - In-flight + `targetLocales = [fr]` → only `fr` matches.
  // - Not in-flight → false.
  const isLocaleAnalyzing = useCallback(
    (locale: string): boolean => {
      if (!job) return false;
      if (job.status !== "QUEUED" && job.status !== "RUNNING") return false;
      const targets = job.targetLocales;
      if (targets === null) return true;
      return targets.includes(locale);
    },
    [job],
  );

  const value = useMemo<AstroAutopilotContextValue>(
    () => ({
      astroConfigured,
      data,
      job,
      phase,
      perLocaleAnalyzedAt,
      selected,
      toggleProposal,
      setLocaleSelection,
      proposalsForLocale,
      isLocaleAnalyzing,
      minPopularity,
      maxDifficulty,
      setMinPopularity,
      setMaxDifficulty,
      runAnalyze,
      applyAutoDecay,
      applyLocaleSelection,
      applyingAuto,
    }),
    [
      astroConfigured,
      data,
      job,
      phase,
      perLocaleAnalyzedAt,
      selected,
      toggleProposal,
      setLocaleSelection,
      proposalsForLocale,
      isLocaleAnalyzing,
      minPopularity,
      maxDifficulty,
      runAnalyze,
      applyAutoDecay,
      applyLocaleSelection,
      applyingAuto,
    ],
  );

  return <AstroAutopilotContext.Provider value={value}>{children}</AstroAutopilotContext.Provider>;
}

// Re-export proposal types so consumers can stay one-import.
export type { AstroSwapProposal };
