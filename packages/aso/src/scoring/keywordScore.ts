import type {
  KeywordBucket,
  KeywordSignalInput,
  KeywordSignalOutput,
} from "../types";
import { localeLanguageMultiplier, multiWordBoost } from "./multipliers";

/**
 * Composite keyword score — Astro signals + (optional) locale/cluster
 * multipliers. Unified post-audit so the persisted score on
 * KeywordSignal matches the proposal-ranking score computed inside
 * AstroAutopilot.
 *
 * Weighted blend of the Astro signals we receive per (keyword × store):
 *
 *   • volume / maxVolume       (Astro popularity, 0–100)    weight 0.40
 *   • difficulty (inverted)    (Astro 0–100, lower=easier)  weight 0.25
 *   • maxReachChance           (Astro reach estimate)       weight 0.15
 *   • appStoreRank (inverted)  (Astro rank, 1=best)         weight 0.20
 *
 * Optional post-multipliers — applied ONLY when the caller passes the
 * relevant context:
 *
 *   • `keyword` + `localeHint` → language-match multiplier [0.45, 1.10].
 *     Czech-diacritic candidates score higher in cs locale, Cyrillic
 *     candidates score higher in ru/uk/bg, etc.
 *   • `keyword`                → multi-word boost [0.85, 1.05, 1.15]
 *     (1-word generic vs 3+ word long-tail).
 *   • `clusterBonus`           → flat additive 0..1 (NOT applied here —
 *     reserved for callers that have cluster context like
 *     AstroAutopilot.scoreAstroCandidate; persistence layer typically
 *     doesn't know the cluster, so it skips this).
 *
 * Every input signal is allowed to be null — the base weights are
 * re-normalised across whatever signals are present, so a keyword that
 * Astro has popularity for but no difficulty still produces a sensible
 * score.
 */
export function keywordScore(input: KeywordSignalInput): KeywordSignalOutput {
  const components: { weight: number; value: number }[] = [];

  if (input.volume != null && input.maxVolume != null && input.maxVolume > 0) {
    components.push({ weight: 0.40, value: clamp01(input.volume / input.maxVolume) });
  } else if (input.volume != null) {
    // No explicit cap — Astro's popularity is on a 0-100 scale.
    components.push({ weight: 0.40, value: clamp01(input.volume / 100) });
  }
  if (input.difficulty != null) {
    // Invert: difficulty 0 → 1.0 ease, difficulty 100 → 0.0 ease
    components.push({ weight: 0.25, value: clamp01(1 - input.difficulty / 100) });
  }
  if (input.maxReachChance != null) {
    // Treat maxReachChance as a 0-100 percentage when ≤100; otherwise
    // log-normalise so big absolute reach numbers don't dominate.
    const norm = input.maxReachChance <= 100
      ? input.maxReachChance / 100
      : Math.min(1, Math.log10(input.maxReachChance + 1) / 7);
    components.push({ weight: 0.15, value: clamp01(norm) });
  }
  if (input.appStoreRank != null) {
    // Inverse rank curve — rank 1 ⇒ 1.0, rank 50 ⇒ 0.02, off-top-50 ⇒ 0
    components.push({ weight: 0.20, value: 1 / Math.max(input.appStoreRank, 1) });
  }

  if (components.length === 0) {
    return { score: 0, bucket: "NEUTRAL" };
  }

  // Re-normalise weights across the components we actually have
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const baseScore = components.reduce((s, c) => s + (c.weight / totalWeight) * c.value, 0);

  // Apply optional multipliers — long-tail boost first (depends on the
  // keyword string itself), then language match (depends on locale).
  // Both compose multiplicatively; callers can opt out by omitting the
  // params.
  let score = baseScore;
  if (input.keyword) {
    score *= multiWordBoost(input.keyword);
    if (input.localeHint) {
      score *= localeLanguageMultiplier(input.keyword, input.localeHint);
    }
  }

  return { score: round(clamp01(score), 3), bucket: bucketFor(score, input) };
}

function bucketFor(score: number, input: KeywordSignalInput): KeywordBucket {
  const clampedScore = clamp01(score);
  // Decay overrides everything — call attention immediately
  if (input.appStoreRank == null && clampedScore < 0.2) return "DECAY";

  if (clampedScore >= 0.75) return "CHAMPION";
  if (clampedScore >= 0.4 && (input.appStoreRank == null || input.appStoreRank > 10)) {
    return "OPPORTUNITY";
  }
  // RISING / FALLING are delta-based buckets — see
  // packages/aso/src/scoring/temporalBucket.ts. From a single-day
  // input we never assign them here.
  return "NEUTRAL";
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function round(v: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
