import type { FunnelDiagnostic } from "../types";

interface DailyPoint {
  date: Date;
  impressions: number;
  pageViews: number;
  downloads: number;
}

/**
 * Detect anomalies in the funnel relative to the prior baseline window.
 *
 * Simple z-score style detector — for V1 we only flag the obvious 2σ+
 * moves on PVCR and impressions. AI-based context lives in Phase 11.
 *
 *   anomaly if |today - baseline| / stddev > 2
 *   severity: 2-3σ = LOW, 3-4σ = MEDIUM, >4σ = HIGH
 */
export function detectFunnelAnomalies(
  series: DailyPoint[],
  options: { baselineWindowDays?: number } = {},
): FunnelDiagnostic[] {
  const baselineWindowDays = options.baselineWindowDays ?? 14;
  if (series.length < baselineWindowDays + 1) return [];

  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  const today = sorted[sorted.length - 1];
  if (!today) return [];
  const baseline = sorted.slice(-baselineWindowDays - 1, -1);
  if (baseline.length === 0) return [];

  const diagnostics: FunnelDiagnostic[] = [];

  const todayPvcr = pvcr(today);
  const pvcrSeries = baseline.map(pvcr);
  const pvcrAnomaly = zScoreAnomaly(todayPvcr, pvcrSeries);
  if (pvcrAnomaly && Math.abs(pvcrAnomaly.z) >= 2) {
    diagnostics.push({
      kind: pvcrAnomaly.z < 0 ? "PVCR_DROP" : "PVCR_SPIKE",
      severity: severityFromZ(Math.abs(pvcrAnomaly.z)),
      message: `Conversion rate ${pvcrAnomaly.z < 0 ? "dropped" : "spiked"} ${pct(pvcrAnomaly.delta)} vs ${baselineWindowDays.toString()}-day baseline`,
      detectedAt: today.date,
      metricDelta: pvcrAnomaly.delta,
      baselineWindowDays,
    });
  }

  const impAnomaly = zScoreAnomaly(today.impressions, baseline.map((p) => p.impressions));
  if (impAnomaly && Math.abs(impAnomaly.z) >= 2) {
    diagnostics.push({
      kind: impAnomaly.z < 0 ? "IMPRESSION_DROP" : "IMPRESSION_SPIKE",
      severity: severityFromZ(Math.abs(impAnomaly.z)),
      message: `Impressions ${impAnomaly.z < 0 ? "dropped" : "spiked"} ${pct(impAnomaly.delta)} vs ${baselineWindowDays.toString()}-day baseline`,
      detectedAt: today.date,
      metricDelta: impAnomaly.delta,
      baselineWindowDays,
    });
  }

  return diagnostics;
}

function pvcr(p: DailyPoint): number {
  if (p.pageViews === 0) return 0;
  return (p.downloads / p.pageViews) * 100;
}

function zScoreAnomaly(
  current: number,
  baseline: number[],
): { z: number; delta: number } | null {
  if (baseline.length < 3) return null;
  const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
  const variance =
    baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / baseline.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return null;
  const z = (current - mean) / stddev;
  const delta = mean === 0 ? 0 : ((current - mean) / mean) * 100;
  return { z, delta };
}

function severityFromZ(z: number): "LOW" | "MEDIUM" | "HIGH" {
  if (z >= 4) return "HIGH";
  if (z >= 3) return "MEDIUM";
  return "LOW";
}

function pct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}
