import { Queue, type DefaultJobOptions } from "bullmq";
import IORedis from "ioredis";

function makeConnection(): IORedis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new IORedis(url, { maxRetriesPerRequest: null });
}

const connection = (globalThis as Record<string, unknown>).__gp_jobs_conn__ as
  | IORedis
  | undefined;

const conn = connection ?? makeConnection();
(globalThis as Record<string, unknown>).__gp_jobs_conn__ = conn;

// ───────────────────────────────────────────────────────────────────────
// Job payload types
// ───────────────────────────────────────────────────────────────────────

export interface MetadataFetchJobData {
  tenantId: string;
  userId: string;
  appId: string;
  overwriteLocalEdits?: boolean;
}

export interface MetadataPushJobData {
  tenantId: string;
  userId: string;
  appId: string;
  locales?: string[];
  includeVersionSettings?: boolean;
}

export interface ScreenshotUploadJobData {
  tenantId: string;
  userId: string;
  appId: string;
  /** Scratch storage key with the original bytes. */
  scratchKey: string;
  locale: string;
  displayType: string;
  fileName: string;
  fileSize: number;
}

export interface AsoAnalyticsSyncJobData {
  tenantId: string;
  userId: string;
  appId: string;
  /** Single-date mode: UTC date to fetch, YYYY-MM-DD. Defaults to "yesterday". */
  date?: string;
  /** Backfill mode: inclusive start date YYYY-MM-DD. Set with `toDate`. */
  fromDate?: string;
  /** Backfill mode: inclusive end date YYYY-MM-DD. Set with `fromDate`. */
  toDate?: string;
}

/** Per-app daily check — fans out from the nightly scheduler OR is
 *  enqueued manually by a user clicking "Run check now". */
export interface AsoDailyCheckJobData {
  tenantId: string;
  /** User who triggered the run. May be null when fired by the cron
   *  scheduler (no real user behind it). */
  userId?: string | null;
  appId: string;
  /** YYYY-MM-DD. Defaults to today UTC. */
  date?: string;
  /** Free-text "what changed yesterday" to feed the analyst.
   *  Only set on manual runs from the UI. */
  recentChanges?: string;
  /** Set false to skip the AI analyst (cron mode honours it). */
  withAnalyst?: boolean;
  /** When true, run Astro analyze + signal sync FIRST so today's
   *  KeywordSignal rows exist before the alarm engine compares deltas.
   *  Nightly cron sets this to `true`; manual UI runs leave it false
   *  (Astro is a separate button on the per-app page). */
  refreshAstroFirst?: boolean;
}

/** Nightly fan-out job — runs in one of two modes:
 *
 *   • mode='astro'        → fans out one aso.astro.analyze per app, so
 *                           today's KeywordSignal rows get refreshed
 *                           before the alarm engine compares against
 *                           yesterday. Scheduled 05:00 UTC.
 *   • mode='daily-check'  → fans out one aso.daily-check per app to
 *                           evaluate alarms + write notifications.
 *                           Scheduled 06:00 UTC, one hour after Astro.
 *   • mode='analytics'    → fans out one aso.analytics.sync per
 *                           connected iOS app. Pulls App Store Connect
 *                           Analytics + Sales/Trends Reports for the
 *                           previous 2 days (Apple's reports lag ~36 h
 *                           after day close, so always asking for
 *                           "yesterday only" leaves us with empty rows
 *                           half the time). Scheduled 04:00 UTC — runs
 *                           BEFORE the astro + daily-check waves so
 *                           the alarm engine sees fresh numbers.
 *
 * All modes share the same queue + processor so only one repeatable
 * cron registration cycle is needed at boot. */
export interface AsoDailyCheckScheduleJobData {
  /** Which fan-out to run. Defaults to 'daily-check' for backwards
   *  compatibility (manual triggers from the test script). */
  mode?: "astro" | "daily-check" | "analytics" | "competitor-sync";
  /** Optional tenant scope — when set, only fan out to that tenant's
   *  apps. When undefined, the worker iterates every connected app
   *  it can see (RLS-bypass path, since cron has no tenant context). */
  tenantId?: string;
  /** YYYY-MM-DD the fan-out should target. Defaults to today UTC. */
  date?: string;
}

/** Per-app competitor sync — refreshes each monitored competitor's
 *  iTunes Lookup metadata in every active locale's territory, diffs
 *  against the prior snapshot, writes new CompetitorSnapshot rows,
 *  emits AsoNotification rows on changes. Mirrors the per-app shape
 *  of `aso.daily-check` so the same nightly fan-out can drive both. */
export interface AsoCompetitorSyncJobData {
  tenantId: string;
  /** User who triggered the run — null when fired by cron. */
  userId?: string | null;
  appId: string;
  /** YYYY-MM-DD. Defaults to today UTC. */
  date?: string;
  /** Run even on competitors flagged `monitor=false`. Used by the
   *  per-card "Sync now" button so the operator can refresh an
   *  unmonitored competitor without flipping the flag first. */
  includeUnmonitored?: boolean;
  /** Restrict the run to specific competitor ids. Used by the
   *  per-card "Sync now" path so we don't refetch the whole roster
   *  when the operator only cares about one competitor. */
  competitorIds?: string[];
}

export interface AsoAstroAnalyzeJobData {
  tenantId: string;
  userId: string;
  appId: string;
  /** Optional locale filter — defaults to every locale with keywords. */
  locales?: string[];
  /** Mine competitor keywords (up to 5 extra Astro calls per territory).
   *  Default false to stay under Astro's 30 req/min limit on multi-
   *  locale apps. */
  includeCompetitorMining?: boolean;
  /** Skip territories with zero tracked keywords. Default true. */
  skipEmptyTerritories?: boolean;
  maxProposalsPerLocale?: number;
  maxAutoSwapsPerLocale?: number;
  minStrengthDelta?: number;
  /** Enrich top candidates with real Apple metrics via add_keywords. */
  enrichWithMetrics?: boolean;
  /** Realistic-target popularity floor (0-100, Apple's index). */
  minPopularity?: number;
  /** Realistic-target difficulty ceiling (0-100). */
  maxDifficulty?: number;
}

/** Build & deploy pipeline (Deploy tab). Consumed by the macOS runner
 *  (apps/runner), NOT the Linux worker — xcodebuild/altool need macOS. */
export interface BuildRunJobData {
  tenantId: string;
  userId: string;
  appId: string;
  /** The `Build` row id. Doubles as the BullMQ idempotency key. */
  buildId: string;
  platform: "IOS" | "ANDROID";
  target:
    | "FIREBASE_APP_DISTRIBUTION"
    | "APPLE_TESTFLIGHT"
    | "APPLE_APP_STORE"
    | "GOOGLE_PLAY";
  /** Git ref override (branch/tag/sha). Falls back to AppBuildConfig.gitRef. */
  gitRef?: string;
  releaseNotes?: string;
}

export interface JobDataMap {
  "metadata.fetch": MetadataFetchJobData;
  "metadata.push": MetadataPushJobData;
  "screenshot.upload": ScreenshotUploadJobData;
  "aso.analytics.sync": AsoAnalyticsSyncJobData;
  "aso.astro.analyze": AsoAstroAnalyzeJobData;
  "aso.daily-check": AsoDailyCheckJobData;
  "aso.daily-check.schedule": AsoDailyCheckScheduleJobData;
  "aso.competitor-sync": AsoCompetitorSyncJobData;
  "build.run": BuildRunJobData;
}

export type QueueName = keyof JobDataMap;

// ───────────────────────────────────────────────────────────────────────
// Queue instances (singletons)
// ───────────────────────────────────────────────────────────────────────

function makeQueue<K extends QueueName>(
  name: K,
  optsOverride?: Partial<DefaultJobOptions>,
): Queue<JobDataMap[K]> {
  const key = `__gp_queue_${name}__`;
  const g = globalThis as Record<string, unknown>;
  if (g[key]) return g[key] as Queue<JobDataMap[K]>;
  const q = new Queue<JobDataMap[K]>(name, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
      ...optsOverride,
    },
  });
  g[key] = q;
  return q;
}

export const queues = {
  "metadata.fetch": makeQueue("metadata.fetch"),
  "metadata.push": makeQueue("metadata.push"),
  "screenshot.upload": makeQueue("screenshot.upload"),
  "aso.analytics.sync": makeQueue("aso.analytics.sync"),
  "aso.astro.analyze": makeQueue("aso.astro.analyze"),
  "aso.daily-check": makeQueue("aso.daily-check"),
  "aso.daily-check.schedule": makeQueue("aso.daily-check.schedule"),
  "aso.competitor-sync": makeQueue("aso.competitor-sync"),
  // Builds are expensive + side-effectful — NO auto-retry (a half-uploaded
  // TestFlight build / created App Store version must not silently repeat).
  // Keep history long so the Deploy tab's build list survives.
  "build.run": makeQueue("build.run", {
    attempts: 1,
    removeOnComplete: { age: 30 * 24 * 60 * 60, count: 500 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 500 },
  }),
} satisfies { [K in QueueName]: Queue<JobDataMap[K]> };

export { conn as bullConnection };
