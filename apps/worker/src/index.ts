/**
 * BullMQ worker entrypoint. Three queues are consumed in parallel:
 *
 *   metadata.fetch    — paginated pull from App Store Connect / Google Play
 *   metadata.push     — per-locale upsert with smart commit
 *   screenshot.upload — 3-step Apple / raw multipart Google
 *
 * Per-queue concurrency is small (5) so a single tenant cannot block all
 * tenants when running a 35-locale push. Each job's progress is forwarded
 * to Redis pub/sub so the web SSE endpoint can stream it to the browser.
 */
import "./env"; // MUST be first — loads root .env before any secret/db import.
import { Worker, type Queue } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { prismaUnscoped, assertDbRoleRespectsRls } from "@marquee/db";
import { publishProgress, JobCancelledError } from "@marquee/jobs";
import { getEntitlements, initLicense } from "@marquee/license";
import {
  processAsoAnalyticsSync,
  processAsoAstroAnalyze,
  processAsoCompetitorSync,
  processAsoDailyCheck,
  processAsoDailyCheckSchedule,
  processMetadataFetch,
  processMetadataPush,
  processScreenshotUpload,
  type AsoAnalyticsSyncInput,
  type AsoAstroAnalyzeInput,
  type AsoCompetitorSyncInput,
  type AsoDailyCheckInput,
  type AsoDailyCheckScheduleInput,
  type MetadataFetchInput,
  type MetadataPushInput,
  type ScreenshotUploadInput,
} from "./processors";
import { queues } from "@marquee/jobs";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
});

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

// BullMQ's `job.id` is no longer the DB row's UUID (idempotency keys +
// BullMQ ≥5 forbidding ':' in jobIds force us to use `idem-…` prefixes).
// Resolve once via the unique `bullJobId` column so the rest of the
// worker — processors, publishProgress, SSE — keep speaking real UUIDs.
async function resolveDbJobId(bullJobId: string): Promise<string | null> {
  const row = await prismaUnscoped.job.findUnique({
    where: { bullJobId },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function markRunning(dbJobId: string): Promise<void> {
  try {
    await prismaUnscoped.job.update({
      where: { id: dbJobId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
  } catch {
    /* job row may not exist if the API skipped DB write */
  }
}

async function markCompleted(dbJobId: string, result: unknown): Promise<void> {
  // Round-trip through JSON.stringify so we don't surface non-serialisable
  // values (Date, undefined, functions) to Prisma. Then `any`-cast for the
  // Json column — Prisma's InputJsonValue union doesn't accept the wide
  // Record<string, unknown> shape, so the cast bridges the gap safely.
  const safe = JSON.parse(JSON.stringify(result ?? {})) as unknown;
  // Conditional update — never overwrite a CANCELLED status. If the user
  // cancelled the job mid-flight and the worker still managed to return a
  // result, we honour the cancellation. Same idea for already-FAILED.
  await prismaUnscoped.job.updateMany({
    where: { id: dbJobId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "COMPLETED",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: safe as any,
      finishedAt: new Date(),
    },
  }).catch(() => undefined);
  // Best-effort progress publish — if the row was already CANCELLED,
  // publishProgress will throw JobCancelledError; we swallow it here
  // because there's nothing to unwind at this point.
  try {
    await publishProgress({ jobId: dbJobId, current: 1, total: 1, step: "completed", level: "info" });
  } catch (err: unknown) {
    if (!(err instanceof JobCancelledError)) throw err;
  }
}

async function markFailed(dbJobId: string, err: Error): Promise<void> {
  // If the worker threw JobCancelledError, the DB row is already CANCELLED
  // — record the BullMQ-level failure event in logs but don't clobber the
  // user-facing terminal state.
  if (err instanceof JobCancelledError) {
    logger.info({ jobId: dbJobId }, "Job cancelled by user — worker unwound cleanly");
    return;
  }
  await prismaUnscoped.job.updateMany({
    where: { id: dbJobId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "FAILED",
      error: { message: err.message, name: err.name },
      finishedAt: new Date(),
    },
  }).catch(() => undefined);
  try {
    await publishProgress({
      jobId: dbJobId,
      current: 0,
      total: 1,
      step: "failed",
      level: "error",
      detail: err.message,
    });
  } catch (e: unknown) {
    if (!(e instanceof JobCancelledError)) throw e;
  }
}

/**
 * Read-only freeze for the worker: refuse store-mutating work while the
 * subscription is on hold. Reads getEntitlements() FRESH each call (the in-memory
 * verdict cache was removed, so a suspension delivered by a background token
 * refresh takes effect without a worker restart). No-op unless a Polar token
 * reports suspended.
 *
 * NOTE (Phase 2): a throw here marks the BullMQ job FAILED. Convert this to a
 * deferral (job.moveToDelayed) so a transient hold PAUSES queued work rather
 * than terminally failing it.
 */
function assertBillingNotSuspended(): void {
  if (getEntitlements().billingState === "suspended") {
    throw new Error("Subscription on hold — paused until billing resumes");
  }
}

async function runWith<TData>(
  job: { id?: string; data: TData },
  processor: (input: TData & { jobId: string }) => Promise<unknown>,
): Promise<unknown> {
  const bullJobId = job.id!;
  const dbJobId = (await resolveDbJobId(bullJobId)) ?? bullJobId;
  // BullMQ's per-job map stashes the resolved id on the job object so
  // the "completed"/"failed" callbacks don't have to look it up again.
  (job as { _dbJobId?: string })._dbJobId = dbJobId;
  assertBillingNotSuspended();
  await markRunning(dbJobId);
  return processor({ ...job.data, jobId: dbJobId });
}

function dbIdOf(job: { id?: string; _dbJobId?: string } | undefined): string | null {
  if (!job) return null;
  return job._dbJobId ?? job.id ?? null;
}

const metadataFetchWorker = new Worker<MetadataFetchInput>(
  "metadata.fetch",
  (job) => runWith<MetadataFetchInput>(job, processMetadataFetch),
  { connection, concurrency: 5 },
);
metadataFetchWorker.on("completed", (job, result) => {
  const id = dbIdOf(job);
  if (id) void markCompleted(id, result);
});
metadataFetchWorker.on("failed", (job, err) => {
  const id = dbIdOf(job);
  if (id) void markFailed(id, err);
});

const metadataPushWorker = new Worker<MetadataPushInput>(
  "metadata.push",
  (job) => runWith<MetadataPushInput>(job, processMetadataPush),
  { connection, concurrency: 5 },
);
metadataPushWorker.on("completed", (job, result) => {
  const id = dbIdOf(job);
  if (id) void markCompleted(id, result);
});
metadataPushWorker.on("failed", (job, err) => {
  const id = dbIdOf(job);
  if (id) void markFailed(id, err);
});

const screenshotUploadWorker = new Worker<ScreenshotUploadInput>(
  "screenshot.upload",
  (job) => runWith<ScreenshotUploadInput>(job, processScreenshotUpload),
  { connection, concurrency: 10 },
);
screenshotUploadWorker.on("completed", (job, result) => {
  const id = dbIdOf(job);
  if (id) void markCompleted(id, result);
});
screenshotUploadWorker.on("failed", (job, err) => {
  const id = dbIdOf(job);
  if (id) void markFailed(id, err);
});

const asoAnalyticsWorker = new Worker<AsoAnalyticsSyncInput>(
  "aso.analytics.sync",
  (job) => runWith<AsoAnalyticsSyncInput>(job, processAsoAnalyticsSync),
  { connection, concurrency: 3 },
);
asoAnalyticsWorker.on("completed", (job, result) => {
  const id = dbIdOf(job);
  if (id) void markCompleted(id, result);
});
asoAnalyticsWorker.on("failed", (job, err) => {
  const id = dbIdOf(job);
  if (id) void markFailed(id, err);
});

// Astro Autopilot — long-running because of Astro Desktop's
// 30 req/min rate limit; concurrency 1 so a re-run for the same app
// queues behind the previous run instead of stomping it.
const asoAstroAnalyzeWorker = new Worker<AsoAstroAnalyzeInput>(
  "aso.astro.analyze",
  (job) => runWith<AsoAstroAnalyzeInput>(job, processAsoAstroAnalyze),
  { connection, concurrency: 1 },
);
asoAstroAnalyzeWorker.on("completed", (job, result) => {
  const id = dbIdOf(job);
  if (id) void markCompleted(id, result);
});
asoAstroAnalyzeWorker.on("failed", (job, err) => {
  const id = dbIdOf(job);
  if (id) void markFailed(id, err);
});

// ─────────────────────────────────────────────────────────────────────
// ASO Daily Check — alarm engine + analyst per (app × date).
// Concurrency 3: a daily fan-out enqueues N jobs (one per app), and
// we want them to drain quickly without hammering Astro / the AI
// provider. Astro Autopilot already has its own 30-req/min limiter
// when refreshAstroFirst chains them — independent caps stack.
// ─────────────────────────────────────────────────────────────────────
const asoDailyCheckWorker = new Worker<AsoDailyCheckInput>(
  "aso.daily-check",
  // No DB Job row for these — fired by cron, not by an API endpoint.
  // We call processAsoDailyCheck directly without runWith()'s row lookup, but
  // still honour the billing freeze so a suspended instance writes no ASO rows.
  async (job) => {
    assertBillingNotSuspended();
    return processAsoDailyCheck(job.data);
  },
  { connection, concurrency: 3 },
);
asoDailyCheckWorker.on("completed", (_job, result) => {
  logger.info({ daily: result }, "aso.daily-check completed");
});
asoDailyCheckWorker.on("failed", (job, err) => {
  logger.error(
    { appId: job?.data.appId, date: job?.data.date, err: err.message },
    "aso.daily-check failed",
  );
});

// ─────────────────────────────────────────────────────────────────────
// ASO Competitor Sync — iTunes Lookup fan-out per (competitor × territory).
// Concurrency 1: Apple's empirical ~20 req/min Lookup ceiling means we
// can't run multiple per-app syncs in parallel without bursting the
// shared per-IP bucket. Per-app pacing lives inside the processor
// (250 ms between iTunes Lookup calls); the queue layer just keeps
// the apps lined up.
// ─────────────────────────────────────────────────────────────────────
const asoCompetitorSyncWorker = new Worker<AsoCompetitorSyncInput>(
  "aso.competitor-sync",
  async (job) => {
    assertBillingNotSuspended();
    return processAsoCompetitorSync(job.data);
  },
  { connection, concurrency: 1 },
);
asoCompetitorSyncWorker.on("completed", (_job, result) => {
  logger.info({ sync: result }, "aso.competitor-sync completed");
});
asoCompetitorSyncWorker.on("failed", (job, err) => {
  logger.error(
    { appId: job?.data.appId, date: job?.data.date, err: err.message },
    "aso.competitor-sync failed",
  );
});

// Nightly fan-out scheduler. ONE repeat job that itself enqueues
// per-app jobs onto aso.daily-check.
const asoDailyCheckScheduleWorker = new Worker<AsoDailyCheckScheduleInput>(
  "aso.daily-check.schedule",
  async (job) => {
    assertBillingNotSuspended();
    return processAsoDailyCheckSchedule(job.data);
  },
  { connection, concurrency: 1 },
);
asoDailyCheckScheduleWorker.on("completed", (_job, result) => {
  logger.info({ schedule: result }, "aso.daily-check.schedule fanned out");
});
asoDailyCheckScheduleWorker.on("failed", (_job, err) => {
  logger.error({ err: err.message }, "aso.daily-check.schedule failed");
});

// Register the repeatable crons on boot.
//
// Three-stage nightly pipeline:
//   1. 04:00 UTC — Analytics + Sales Reports fan-out. Pulls App Store
//      Connect Analytics + Sales Reports for the previous 2 days so
//      Apple's ~36h publishing lag doesn't leave the freshest day
//      empty. Without this cron, AnalyticsSnapshot only ever updates
//      when the user clicks "Smart sync" by hand — the silent failure
//      mode users hit on day-2 of a fresh app.
//   2. 05:00 UTC — Astro Autopilot fan-out. Refreshes today's
//      KeywordSignal rows (rank + Astro popularity + difficulty) for
//      every connected app so the alarm engine has fresh data.
//   3. 06:00 UTC — Daily-check fan-out. Reads the freshly-written
//      signals + competitor ranks, evaluates alarms, calls the
//      analyst, writes notifications.
//
// Three separate crons (not chained) so a slow run for one tenant
// can't block another tenant's downstream stages. The hour-apart gaps
// are generous — Astro's 25 req/min limiter caps a worst-case
// 600-keyword multi-locale app at ~30 minutes, and Apple's report
// downloads (with concurrency=3) finish well under the hour.
async function registerNightlySchedules(): Promise<void> {
  // Re-use aso.daily-check.schedule's processor as the dispatcher for
  // every nightly cron. The schedule payload carries a `mode`
  // discriminant so the same handler knows which queue to fan out to.
  //
  // Why competitor-sync runs at 03:00 (before everything else): it's
  // pure HTTP against Apple's CDN-cached iTunes Lookup, has no
  // dependency on Astro or our own data, and a competitor's published
  // metadata is what drives the per-app daily-check's competitor-
  // intrusion alarms. Running it first means by the time daily-check
  // fires at 06:00 we already know "Magic Sort shipped v25.79 today,
  // here's the new release notes" alongside the rank deltas.
  await registerRepeat(
    queues["aso.daily-check.schedule"],
    "nightly-competitor-sync",
    "0 3 * * *",
    { mode: "competitor-sync" },
  );
  await registerRepeat(
    queues["aso.daily-check.schedule"],
    "nightly-analytics-sync",
    "0 4 * * *",
    { mode: "analytics" },
  );
  await registerRepeat(
    queues["aso.daily-check.schedule"],
    "nightly-astro-refresh",
    "0 5 * * *",
    { mode: "astro" },
  );
  await registerRepeat(
    queues["aso.daily-check.schedule"],
    "nightly-daily-check",
    "0 6 * * *",
    { mode: "daily-check" },
  );
}

async function registerRepeat<TPayload>(
  queue: Queue<TPayload>,
  jobId: string,
  cronPattern: string,
  payload: TPayload,
): Promise<void> {
  try {
    const repeats = await queue.getRepeatableJobs();
    for (const r of repeats) {
      if (r.id === jobId) {
        await queue.removeRepeatableByKey(r.key);
      }
    }
    // BullMQ's `add()` overload uses an ExtractNameType<TPayload, string>
    // generic that doesn't simplify to plain `string` when called from a
    // generic helper. Cast keeps the helper reusable without losing
    // payload typing on the caller side.
    await (queue.add as (n: string, d: TPayload, o: unknown) => Promise<unknown>)(
      jobId,
      payload,
      { repeat: { pattern: cronPattern, tz: "UTC" }, jobId },
    );
    logger.info({ jobId, pattern: cronPattern }, "registered repeatable cron");
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err) },
      "could not register cron (will retry on next worker boot)",
    );
  }
}
void registerNightlySchedules();

// Reconcile orphan jobs on startup.
//
// When the worker is killed mid-flight (Ctrl+C, tsx-watch restart, OOM)
// AFTER the BullMQ processor returned but BEFORE the "completed" event
// reached our `markCompleted` handler, the DB row gets stuck on RUNNING
// even though BullMQ recorded `returnvalue` + `finishedOn` on its side.
// The UI then shows "still running" forever.
//
// On startup, scan BullMQ's `completed` + `failed` sets for jobs whose
// DB rows are still in a non-terminal state, and reconcile them. Idem-
// potent — runs every startup, only touches mismatches.
async function reconcileOrphanJobs(): Promise<void> {
  const queueNames = [
    "metadata.fetch",
    "metadata.push",
    "screenshot.upload",
    "aso.analytics.sync",
    "aso.astro.analyze",
  ] as const;
  // Look back 24h — anything older has either been already reconciled
  // by a previous startup, or is irrelevant to the current dev session.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const candidates = await prismaUnscoped.job.findMany({
    where: {
      kind: { in: [...queueNames] },
      status: { in: ["QUEUED", "RUNNING"] },
      createdAt: { gte: since },
    },
    select: { id: true, kind: true, bullJobId: true, status: true },
  });
  if (candidates.length === 0) return;
  logger.info(
    { count: candidates.length },
    "Reconciling possibly-orphan jobs against BullMQ",
  );
  const { Queue } = await import("bullmq");
  const queueByKind = new Map<string, InstanceType<typeof Queue>>();
  let reconciled = 0;
  for (const row of candidates) {
    if (!row.bullJobId) continue;
    let q = queueByKind.get(row.kind);
    if (!q) {
      q = new Queue(row.kind, { connection });
      queueByKind.set(row.kind, q);
    }
    try {
      const bullJob = await q.getJob(row.bullJobId);
      if (!bullJob) {
        // BullMQ has no record — orphaned without completing.
        await prismaUnscoped.job.updateMany({
          where: { id: row.id, status: { in: ["QUEUED", "RUNNING"] } },
          data: {
            status: "FAILED",
            error: {
              message:
                "Worker restarted before this job completed — no BullMQ record found.",
              code: "WORKER_ORPHANED",
            },
            finishedAt: new Date(),
          },
        });
        reconciled++;
        continue;
      }
      const state = await bullJob.getState();
      if (state === "completed") {
        const finishedAt = bullJob.finishedOn ? new Date(bullJob.finishedOn) : new Date();
        const safe = JSON.parse(JSON.stringify(bullJob.returnvalue ?? {})) as unknown;
        await prismaUnscoped.job.updateMany({
          where: { id: row.id, status: { in: ["QUEUED", "RUNNING"] } },
          data: {
            status: "COMPLETED",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result: safe as any,
            finishedAt,
            progressCurrent: 1,
            progressTotal: 1,
            progressStep: "completed",
          },
        });
        reconciled++;
      } else if (state === "failed") {
        const finishedAt = bullJob.finishedOn ? new Date(bullJob.finishedOn) : new Date();
        await prismaUnscoped.job.updateMany({
          where: { id: row.id, status: { in: ["QUEUED", "RUNNING"] } },
          data: {
            status: "FAILED",
            error: {
              message: bullJob.failedReason ?? "Job failed (no reason recorded)",
              code: "WORKER_RECONCILED_FAILED",
            },
            finishedAt,
          },
        });
        reconciled++;
      }
      // For state === "active" / "waiting" / "delayed" / "waiting-children",
      // leave the row alone — the BullMQ worker will pick it up shortly.
    } catch (err) {
      logger.warn({ err, jobId: row.id }, "Reconciliation lookup failed");
    }
  }
  // Quietly close the temporary queue handles
  await Promise.all([...queueByKind.values()].map((q) => q.close()));
  if (reconciled > 0) {
    logger.info({ reconciled, total: candidates.length }, "Orphan jobs reconciled");
  }
}

// Fail-secure: in production, refuse to run if the DB role bypasses RLS
// (superuser/BYPASSRLS), since that silently disables tenant isolation.
void assertDbRoleRespectsRls().catch((err: unknown) => {
  logger.error(
    { err: err instanceof Error ? err.message : err },
    "DB role RLS safety check failed — exiting",
  );
  process.exit(1);
});

void reconcileOrphanJobs().catch((err) => {
  logger.error({ err }, "Orphan reconciliation failed at startup");
});

// Sealed-distribution license check. OFFLINE (verifies the cached token locally)
// + FAIL-OPEN, and a complete NO-OP unless MARQUEE_LICENSE_ENFORCEMENT=on, so dev
// and existing self-host are unaffected. The worker is a single long-lived
// process — the natural home for the periodic background refresh/heartbeat.
try {
  const lic = initLicense((msg, extra) => logger.info({ extra }, `[license] ${msg}`));
  if (lic.enforced && lic.verdict) {
    logger.info({ state: lic.verdict.state, ok: lic.verdict.ok, withinGrace: lic.verdict.withinGrace }, "license verified offline");
  }
} catch (err) {
  // Only reached with MARQUEE_LICENSE_HARD_STOP=on + a definitively-dead verdict.
  logger.error({ err: err instanceof Error ? err.message : err }, "license hard-stop — exiting");
  process.exit(1);
}

logger.info(
  `Release Flight worker up — Redis ${process.env.REDIS_URL ?? "redis://localhost:6379"} — concurrency: metadata.fetch=5, metadata.push=5, screenshot.upload=10, aso.analytics.sync=3, aso.astro.analyze=1`,
);

async function shutdown(): Promise<void> {
  logger.info("Shutdown signal received — closing workers");
  await Promise.all([
    metadataFetchWorker.close(),
    metadataPushWorker.close(),
    screenshotUploadWorker.close(),
    asoAnalyticsWorker.close(),
    asoAstroAnalyzeWorker.close(),
  ]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
