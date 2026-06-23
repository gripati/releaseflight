/**
 * Worker-side adapter factory + job processors. The web app's route
 * handlers call the same logic synchronously; the worker mirrors them so
 * long-running batch operations (metadata.push across 35 locales, ZIP
 * bulk imports) can run off the request loop with SSE-streamed progress.
 *
 * The factory loads credential material from the SecretProvider via the
 * worker's own filesystem mount or AWS Secrets Manager IAM.
 */
import {
  AnalyticsReports,
  AppleApps,
  AppleAuth,
  AppleClient,
  AppleMetadata,
  AppleScreenshots,
  GOOGLE_SCOPES,
  GoogleAuth,
  GoogleClient,
  GoogleImages,
  GoogleListings,
  NotFoundError,
  SalesReports,
  ValidationError,
  iTunesLookup,
  type ItunesLookupResult,
} from "@marquee/core";
import { localeRegion } from "@marquee/core/locale";
import {
  diffCompetitorSnapshots,
  keywordScore,
  temporalBucket,
  applyTemporalOverride,
  buildAsoAnalystDailyTask,
  runDailyCheck,
  type AnalyzeResult,
  type AiEnricher,
  type AiEnricherInput,
  type AiEnricherOutput,
  type AiRelevanceScorer,
  type AiRelevanceScorerInput,
  type AiRelevanceScorerOutput,
  type AlarmEvaluationInput,
  type AnalystCompetitorHighlight,
  type AnalystKeywordHighlight,
  type AnalystMetricSnapshot,
  type AsoAnalystDailyInput,
  type AsoAnalystDailyOutput,
  type AutopilotApp,
  type CompetitorChangeEvent,
  type CompetitorRankDelta,
  type CompetitorSnapshotInput,
  type ConversionDelta,
  type KeywordRankDelta,
  type LocalTrackedKeyword,
} from "@marquee/aso";
import { Prisma } from "@marquee/db";
import { loadAiOrchestratorForTenant } from "./aiOrchestrator";
import { prisma, recordAudit, tenantStorage, tenantTransaction } from "@marquee/db";
import { createSecretProvider } from "@marquee/secrets";
import { generateThumbnail, storage, tenantStorageKey } from "@marquee/storage";
import { publishProgress } from "@marquee/jobs";
import { loadAstroAutopilotForTenant } from "./research";

const secretProvider = createSecretProvider();
const appleAuth = new AppleAuth();
const googleAuth = new GoogleAuth();

async function loadCredentialMaterial(credentialId: string): Promise<{
  kind: "APPLE" | "GOOGLE";
  content: string;
  appleKeyId: string | null;
  appleIssuerId: string | null;
  googleClientEmail: string | null;
  googleProjectId: string | null;
}> {
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred) throw new NotFoundError("Credential not found");
  if (!cred.isActive) throw new ValidationError("Credential is inactive");
  if (cred.kind !== "APPLE" && cred.kind !== "GOOGLE") {
    throw new ValidationError(
      `Credential kind ${cred.kind} cannot be used by store workers — wire its own loader.`,
    );
  }
  const material = await secretProvider.get(cred.secretRef);
  return {
    kind: cred.kind,
    content: material.content,
    appleKeyId: cred.appleKeyId,
    appleIssuerId: cred.appleIssuerId,
    googleClientEmail: cred.googleClientEmail,
    googleProjectId: cred.googleProjectId,
  };
}

async function buildAppleStack(credentialId: string): Promise<{
  apps: AppleApps;
  metadata: AppleMetadata;
  screenshots: AppleScreenshots;
}> {
  const cred = await loadCredentialMaterial(credentialId);
  if (cred.kind !== "APPLE") throw new ValidationError("Credential is not APPLE");
  if (!cred.appleKeyId || !cred.appleIssuerId) {
    throw new ValidationError("Apple credential missing keyId / issuerId");
  }
  const client = new AppleClient(appleAuth, {
    id: credentialId,
    keyId: cred.appleKeyId,
    issuerId: cred.appleIssuerId,
    privateKeyPem: cred.content,
  });
  return {
    apps: new AppleApps(client),
    metadata: new AppleMetadata(client),
    screenshots: new AppleScreenshots(client),
  };
}

async function buildGoogleStack(credentialId: string): Promise<{
  listings: GoogleListings;
  images: GoogleImages;
}> {
  const cred = await loadCredentialMaterial(credentialId);
  const parsed = JSON.parse(cred.content) as {
    client_email: string;
    private_key: string;
    project_id?: string;
  };
  const client = new GoogleClient(
    googleAuth,
    {
      id: credentialId,
      clientEmail: parsed.client_email,
      privateKeyPem: parsed.private_key,
      ...(parsed.project_id !== undefined ? { projectId: parsed.project_id } : {}),
    },
    GOOGLE_SCOPES.ANDROID_PUBLISHER,
  );
  return { listings: new GoogleListings(client), images: new GoogleImages(client) };
}

// ───────────────────────────────────────────────────────────────────────
// metadata.fetch processor
// ───────────────────────────────────────────────────────────────────────

export interface MetadataFetchInput {
  jobId: string;
  tenantId: string;
  userId: string;
  appId: string;
  overwriteLocalEdits?: boolean;
}

export async function processMetadataFetch(
  input: MetadataFetchInput,
): Promise<{ locales: number }> {
  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      // Defense-in-depth: scope by the job's tenantId too. The appId comes
      // from the (untrusted) job payload; pairing it with tenantId rejects a
      // cross-tenant appId even if RLS were ever disabled/misconfigured.
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");

      await publishProgress({
        jobId: input.jobId,
        current: 0,
        total: 1,
        step: "fetching from store",
      });

      if (app.platform === "IOS") {
        const stack = await buildAppleStack(app.credentialId);
        const details = await stack.apps.getFullDetails(app.storeAppId ?? app.bundleId);
        if (!details) throw new NotFoundError("App not found in App Store Connect");

        const [appInfo, versionLocs] = await Promise.all([
          stack.metadata.fetchAppInfoLocalizations(details.storeAppId),
          details.versionId
            ? stack.metadata.fetchVersionLocalizations(details.versionId)
            : Promise.resolve(new Map()),
        ]);
        const merged = stack.metadata.mergeLocalizations(appInfo, versionLocs);

        await tenantTransaction(async (tx) => {
          await tx.app.update({
            where: { id: input.appId },
            data: {
              storeAppId: details.storeAppId,
              versionId: details.versionId,
              versionString: details.versionString,
              status: details.status,
              copyright: details.copyright,
              availableLanguages: merged.map((m) => m.locale),
              lastFetchedAt: new Date(),
              dirty: false,
            },
          });
          for (const m of merged) {
            await tx.appLocalization.upsert({
              where: { appId_locale: { appId: input.appId, locale: m.locale } },
              create: {
                appId: input.appId,
                tenantId: app.tenantId,
                locale: m.locale,
                appleAppInfoLocalizationId: m.appInfoLocalizationId,
                appleVersionLocalizationId: m.versionLocalizationId,
                name: m.name,
                subtitle: m.subtitle,
                description: m.description,
                keywords: m.keywords,
                whatsNew: m.whatsNew,
                promotionalText: m.promotionalText,
                marketingUrl: m.marketingUrl,
                supportUrl: m.supportUrl,
                privacyPolicyUrl: m.privacyPolicyUrl,
                dirty: false,
                lastFetchedAt: new Date(),
              },
              update: {
                appleAppInfoLocalizationId: m.appInfoLocalizationId,
                appleVersionLocalizationId: m.versionLocalizationId,
                name: m.name,
                subtitle: m.subtitle,
                description: m.description,
                keywords: m.keywords,
                whatsNew: m.whatsNew,
                promotionalText: m.promotionalText,
                marketingUrl: m.marketingUrl,
                supportUrl: m.supportUrl,
                privacyPolicyUrl: m.privacyPolicyUrl,
                dirty: false,
                lastFetchedAt: new Date(),
              },
            });
          }
        });

        await recordAudit({
          action: "metadata.fetch.job",
          target: `app:${input.appId}`,
          appId: input.appId,
          outcome: "SUCCESS",
          diff: { locales: merged.length },
        });
        return { locales: merged.length };
      }

      // ANDROID
      const stack = await buildGoogleStack(app.credentialId);
      const listings = await stack.listings.fetchAll(app.bundleId);
      const arr = [...listings.values()];
      await tenantTransaction(async (tx) => {
        await tx.app.update({
          where: { id: input.appId },
          data: {
            availableLanguages: arr.map((l) => l.language),
            lastFetchedAt: new Date(),
            dirty: false,
          },
        });
        for (const l of arr) {
          await tx.appLocalization.upsert({
            where: { appId_locale: { appId: input.appId, locale: l.language } },
            create: {
              appId: input.appId,
              tenantId: app.tenantId,
              locale: l.language,
              name: l.title,
              shortDescription: l.shortDescription,
              description: l.fullDescription,
              videoUrl: l.video,
              dirty: false,
              lastFetchedAt: new Date(),
            },
            update: {
              name: l.title,
              shortDescription: l.shortDescription,
              description: l.fullDescription,
              videoUrl: l.video,
              dirty: false,
              lastFetchedAt: new Date(),
            },
          });
        }
      });

      await recordAudit({
        action: "metadata.fetch.job",
        target: `app:${input.appId}`,
        appId: input.appId,
        outcome: "SUCCESS",
        diff: { locales: arr.length },
      });
      return { locales: arr.length };
    },
  );
}

// ───────────────────────────────────────────────────────────────────────
// metadata.push processor
// ───────────────────────────────────────────────────────────────────────

export interface MetadataPushInput {
  jobId: string;
  tenantId: string;
  userId: string;
  appId: string;
  locales?: string[];
  includeVersionSettings?: boolean;
}

export async function processMetadataPush(input: MetadataPushInput): Promise<{
  succeeded: number;
  failed: number;
  unsupported: number;
}> {
  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      // Defense-in-depth: scope by the job's tenantId too. The appId comes
      // from the (untrusted) job payload; pairing it with tenantId rejects a
      // cross-tenant appId even if RLS were ever disabled/misconfigured.
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");

      const locs = await prisma.appLocalization.findMany({
        where: {
          appId: input.appId,
          ...(input.locales && input.locales.length > 0
            ? { locale: { in: input.locales } }
            : { dirty: true }),
        },
      });

      let succeeded = 0;
      let failed = 0;
      let unsupported = 0;

      if (app.platform === "IOS") {
        const stack = await buildAppleStack(app.credentialId);
        for (let i = 0; i < locs.length; i += 1) {
          const loc = locs[i]!;
          await publishProgress({
            jobId: input.jobId,
            current: i + 1,
            total: locs.length,
            step: `pushing ${loc.locale}`,
          });
          try {
            const r = await stack.metadata.upsertLocalization({
              storeAppId: app.storeAppId ?? app.bundleId,
              versionId: app.versionId,
              canonicalLocale: loc.locale,
              fields: {
                name: loc.name,
                subtitle: loc.subtitle,
                privacyPolicyUrl: loc.privacyPolicyUrl,
                description: loc.description,
                keywords: loc.keywords,
                whatsNew: loc.whatsNew,
                promotionalText: loc.promotionalText,
                marketingUrl: loc.marketingUrl,
                supportUrl: loc.supportUrl,
              },
            });
            const okBoth =
              r.versionLocalization.action !== "failed" &&
              r.appInfoLocalization.action !== "failed";
            if (okBoth) {
              succeeded += 1;
              await prisma.appLocalization.update({
                where: { appId_locale: { appId: input.appId, locale: loc.locale } },
                data: { dirty: false, lastPushedAt: new Date() },
              });
            } else {
              failed += 1;
            }
          } catch {
            failed += 1;
          }
        }
      } else {
        const stack = await buildGoogleStack(app.credentialId);
        const summary = await stack.listings.pushAll({
          packageName: app.bundleId,
          listings: locs.map((l) => ({
            canonicalLocale: l.locale,
            name: l.name ?? "",
            shortDescription: l.shortDescription ?? "",
            description: l.description ?? "",
            videoUrl: l.videoUrl,
          })),
          onProgress: (current, total, locale) => {
            void publishProgress({
              jobId: input.jobId,
              current,
              total,
              step: `pushing ${locale}`,
            });
          },
        });
        succeeded = summary.succeeded.length;
        failed = summary.failed.length;
        unsupported = summary.unsupported.length;
        for (const ok of summary.succeeded) {
          await prisma.appLocalization.update({
            where: { appId_locale: { appId: input.appId, locale: ok.canonical } },
            data: { dirty: false, lastPushedAt: new Date() },
          });
        }
      }

      const stillDirty = await prisma.appLocalization.count({
        where: { appId: input.appId, dirty: true },
      });
      await prisma.app.update({
        where: { id: input.appId },
        data: { dirty: stillDirty > 0, lastPushedAt: new Date() },
      });

      await recordAudit({
        action: "metadata.push.job",
        target: `app:${input.appId}`,
        appId: input.appId,
        outcome: failed === 0 ? "SUCCESS" : succeeded > 0 ? "PARTIAL" : "FAILURE",
        diff: { succeeded, failed, unsupported },
      });

      return { succeeded, failed, unsupported };
    },
  );
}

// ───────────────────────────────────────────────────────────────────────
// screenshot.upload processor
// ───────────────────────────────────────────────────────────────────────

export interface ScreenshotUploadInput {
  jobId: string;
  tenantId: string;
  userId: string;
  appId: string;
  /** scratch object-storage key holding the upload bytes */
  scratchKey: string;
  locale: string;
  displayType: string;
  fileName: string;
  fileSize: number;
}

export async function processScreenshotUpload(
  input: ScreenshotUploadInput,
): Promise<{ screenshotId: string; state: string }> {
  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      // Defense-in-depth: scope by the job's tenantId too. The appId comes
      // from the (untrusted) job payload; pairing it with tenantId rejects a
      // cross-tenant appId even if RLS were ever disabled/misconfigured.
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");

      const scratch = await storage.get(input.scratchKey);
      const thumb = await generateThumbnail(scratch.body, { size: 384 });

      const row = await prisma.screenshot.create({
        data: {
          tenantId: app.tenantId,
          appId: input.appId,
          locale: input.locale,
          ...(app.platform === "IOS"
            ? { appleDisplayType: input.displayType }
            : { googleImageType: input.displayType }),
          fileName: input.fileName,
          width: 0,
          height: 0,
          ordinal:
            (await prisma.screenshot.count({
              where: {
                appId: input.appId,
                locale: input.locale,
                ...(app.platform === "IOS"
                  ? { appleDisplayType: input.displayType }
                  : { googleImageType: input.displayType }),
              },
            })) + 1,
          state: "UPLOADING",
          fileSize: input.fileSize,
          createdBy: input.userId,
        },
      });

      const originalKey = tenantStorageKey(
        app.tenantId,
        "apps",
        input.appId,
        "screenshots",
        row.id,
        "original.png",
      );
      const thumbKey = tenantStorageKey(
        app.tenantId,
        "apps",
        input.appId,
        "screenshots",
        row.id,
        "thumb-384.webp",
      );
      await storage.putBuffer(originalKey, scratch.body, {
        contentType: scratch.contentType ?? "image/png",
      });
      await storage.putBuffer(thumbKey, thumb.buffer, { contentType: thumb.contentType });
      await prisma.screenshot.update({
        where: { id: row.id },
        data: { storageKey: originalKey, thumbnailKey: thumbKey, state: "COMMITTING" },
      });

      await publishProgress({
        jobId: input.jobId,
        current: 1,
        total: 2,
        step: "uploading to store",
      });

      try {
        if (app.platform === "IOS") {
          if (!app.versionId) throw new ValidationError("App has no active version");
          const stack = await buildAppleStack(app.credentialId);
          const r = await stack.screenshots.uploadScreenshot({
            storeAppId: app.storeAppId ?? app.bundleId,
            versionId: app.versionId,
            canonicalLocale: input.locale,
            displayType: input.displayType,
            fileName: input.fileName,
            fileBuffer: scratch.body,
            contentType: scratch.contentType ?? "image/png",
          });
          await prisma.screenshot.update({
            where: { id: row.id },
            data: {
              appleScreenshotId: r.screenshotId,
              state: r.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
              uploadedAt: new Date(),
            },
          });
          await storage.delete(input.scratchKey).catch(() => undefined);
          return { screenshotId: row.id, state: r.state };
        }

        const stack = await buildGoogleStack(app.credentialId);
        const ct = (scratch.contentType ?? "image/png") as "image/png" | "image/jpeg";
        const r = await stack.images.uploadImage({
          packageName: app.bundleId,
          language: input.locale,
          imageType: input.displayType as Parameters<
            typeof stack.images.uploadImage
          >[0]["imageType"],
          fileBuffer: scratch.body,
          contentType: ct,
        });
        await prisma.screenshot.update({
          where: { id: row.id },
          data: {
            googleImageId: r.imageId,
            upstreamUrl: r.url,
            state: "COMPLETE",
            uploadedAt: new Date(),
          },
        });
        await storage.delete(input.scratchKey).catch(() => undefined);
        return { screenshotId: row.id, state: "COMPLETE" };
      } catch (err: unknown) {
        await prisma.screenshot.update({
          where: { id: row.id },
          data: { state: "UPLOAD_FAILED" },
        });
        throw err;
      }
    },
  );
}

// ───────────────────────────────────────────────────────────────────────
// aso.analytics.sync processor
// ───────────────────────────────────────────────────────────────────────
//
// Pulls the previous UTC day's App Store Connect analytics report and
// upserts AnalyticsSnapshot + AnalyticsFunnel rows. Phase 9 wires the
// scheduling + report-request lifecycle; the streaming CSV parse for
// the daily rollup lands in Phase 10 once we have a live test app to
// verify column layout.

export interface AsoAnalyticsSyncInput {
  jobId: string;
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

export async function processAsoAnalyticsSync(input: AsoAnalyticsSyncInput): Promise<{
  mode: "single" | "backfill";
  daysProcessed: number;
  daysWithData: number;
  snapshotsWritten: number;
  funnelsWritten: number;
  firstDate: string;
  lastDate: string;
}> {
  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      // Defense-in-depth: scope by the job's tenantId too. The appId comes
      // from the (untrusted) job payload; pairing it with tenantId rejects a
      // cross-tenant appId even if RLS were ever disabled/misconfigured.
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");
      if (app.platform !== "IOS") {
        throw new ValidationError("aso.analytics.sync currently supports IOS only");
      }
      const storeAppId = app.storeAppId ?? app.bundleId;

      const dates = resolveDateRange(input);
      const mode: "single" | "backfill" = dates.length > 1 ? "backfill" : "single";

      const cred = await loadCredentialMaterial(app.credentialId);
      if (cred.kind !== "APPLE") throw new ValidationError("Credential is not APPLE");
      if (!cred.appleKeyId || !cred.appleIssuerId) {
        throw new ValidationError("Apple credential missing keyId / issuerId");
      }
      const client = new AppleClient(appleAuth, {
        id: app.credentialId,
        keyId: cred.appleKeyId,
        issuerId: cred.appleIssuerId,
        privateKeyPem: cred.content,
      });
      const reports = new AnalyticsReports(client);

      // Sales and Trends Reports — universal fallback (works for any
      // app with any units, no privacy-threshold gate). Activates only
      // when the user has stored their Apple vendor number on the
      // credential.
      const credRow = await prisma.credential.findUnique({
        where: { id: app.credentialId },
        select: { appleVendorNumber: true },
      });
      const vendorNumber = credRow?.appleVendorNumber ?? null;
      const sales = vendorNumber ? new SalesReports(client) : null;

      await publishProgress({
        jobId: input.jobId,
        current: 0,
        total: dates.length,
        step:
          mode === "backfill"
            ? `ensuring report request (backfill ${dates[0]!} → ${dates[dates.length - 1]!}${sales ? " + Sales Reports" : ""})`
            : `ensuring report request (${dates[0]!}${sales ? " + Sales Reports" : ""})`,
      });

      const requestIds = await reports.ensureReportRequest(storeAppId);

      let snapshotsWritten = 0;
      let funnelsWritten = 0;
      let daysWithData = 0;
      let salesDaysWithData = 0;
      // Per-date diagnostics so the audit log records exactly which
      // source produced each day's numbers. Critical for debugging
      // "wrong analytics" reports — lets us see at a glance whether
      // Analytics returned data, what its downloads/sessions were,
      // whether the engagement report (the one with impressions /
      // pageViews) was empty, and whether Sales Reports had to fill in.
      const perDate: {
        date: string;
        analytics: {
          hadData: boolean;
          downloads: number;
          sessions: number;
          impressions: number;
          pageViews: number;
          // Per-report breakdown — `segments` is the most diagnostic
          // single number: 0 means Apple hasn't generated a daily
          // instance for that report yet (ramp-up window). The Apple
          // Discovery & Engagement report is the ONLY source of
          // impressions/pageViews — if its segments=0 those columns
          // will be 0 in the UI no matter what else we fetch.
          perReport: {
            engagement: { segments: number; rows: number; applied: number };
            downloads: { segments: number; rows: number; applied: number };
            sessions: { segments: number; rows: number; applied: number };
            crashes: { segments: number; rows: number; applied: number };
          };
        } | null;
        funnelRows: number;
        sales: { hadData: boolean; units: number; updates: number } | null;
        merged: "analytics-only" | "sales-only" | "analytics+sales-merge" | "none";
      }[] = [];

      for (let i = 0; i < dates.length; i += 1) {
        const date = dates[i]!;
        let analyticsHadData = false;
        let analyticsSummary: (typeof perDate)[number]["analytics"] = null;
        let funnelRowsForDate = 0;
        try {
          const { rollup: daily, diagnostics: perReport } =
            await reports.getDailyRollupWithDiagnostics(storeAppId, date);
          const funnel = await reports.getSourceFunnel(storeAppId, date);
          if (daily) {
            await upsertDailySnapshot(app.tenantId, app.id, daily);
            snapshotsWritten += 1;
            daysWithData += 1;
            analyticsHadData = true;
            analyticsSummary = {
              hadData: true,
              downloads: daily.downloads,
              sessions: daily.sessions,
              impressions: daily.impressions,
              pageViews: daily.pageViews,
              perReport,
            };
          } else {
            // Still record the per-report diagnostic even when the
            // overall rollup was empty — this is the most informative
            // signal for "why are impressions still 0?" investigations.
            analyticsSummary = {
              hadData: false,
              downloads: 0,
              sessions: 0,
              impressions: 0,
              pageViews: 0,
              perReport,
            };
          }
          for (const row of funnel) {
            await upsertFunnelRow(app.tenantId, app.id, row);
            funnelsWritten += 1;
            funnelRowsForDate += 1;
          }
        } catch (err: unknown) {
          await publishProgress({
            jobId: input.jobId,
            current: i + 1,
            total: dates.length,
            step: `${date} analytics: ${(err as Error).message}`,
            level: "warn",
          });
        }

        // Fallback: pull Sales and Trends Reports. If Analytics already
        // had data, we still pull Sales for per-device + per-territory
        // detail Analytics doesn't expose AND to fill in downloads
        // when Analytics returned the row but its Downloads/Engagement
        // report was empty (the classic "fresh app" failure mode —
        // App Sessions ships immediately, App Downloads ramps up over
        // 24-72 h, so the daily rollup gets written with downloads=0
        // even though Sales already has the real units).
        let salesSummary: {
          hadData: boolean;
          units: number;
          updates: number;
        } | null = null;
        if (sales && vendorNumber) {
          try {
            const summary = await sales.getDailySummary({
              vendorNumber,
              date,
              appleId: storeAppId,
            });
            if (summary && (summary.units > 0 || summary.updates > 0)) {
              salesDaysWithData += 1;
              salesSummary = {
                hadData: true,
                units: summary.units,
                updates: summary.updates,
              };
              if (!analyticsHadData) {
                await upsertSalesSnapshot(app.tenantId, app.id, summary);
                snapshotsWritten += 1;
                daysWithData += 1;
              } else {
                // Merge Sales' units into Analytics row when Analytics'
                // downloads=0 (Apple App Downloads report not yet
                // available for fresh apps). Always patches device +
                // territory breakdown into rawJson.
                await mergeSalesIntoSnapshot(app.id, date, summary);
              }
              // Synthesize per-territory funnel rows if Analytics didn't
              // give us any. Source = "ALL" since Sales Reports don't
              // break down by acquisition source.
              if (!analyticsHadData) {
                for (const [territory, units] of summary.perTerritory) {
                  if (!territory) continue;
                  await upsertFunnelRow(app.tenantId, app.id, {
                    date,
                    source: "ALL",
                    territory,
                    impressions: 0,
                    pageViews: 0,
                    downloads: units,
                  });
                  funnelsWritten += 1;
                }
              }
            }
          } catch (err: unknown) {
            await publishProgress({
              jobId: input.jobId,
              current: i + 1,
              total: dates.length,
              step: `${date} sales: ${(err as Error).message}`,
              level: "warn",
            });
          }
        }

        // Record per-date diagnostics. The `merged` discriminant tells
        // us at a glance which source produced this day's numbers —
        // invaluable when debugging "wrong numbers" reports.
        const merged: (typeof perDate)[number]["merged"] =
          !analyticsHadData && !salesSummary
            ? "none"
            : !analyticsHadData && salesSummary
              ? "sales-only"
              : analyticsHadData && salesSummary
                ? "analytics+sales-merge"
                : "analytics-only";
        perDate.push({
          date,
          analytics: analyticsSummary,
          funnelRows: funnelRowsForDate,
          sales: salesSummary,
          merged,
        });

        // Build a one-line diagnostic the UI can show per date. The
        // per-report breakdown is the key signal — when a fresh app
        // shows 0 impressions, the user can see whether it's because
        // Apple's Engagement report has no segments yet (ramp-up) vs
        // segments existed but rows summed to 0 (privacy threshold).
        const pr = analyticsSummary?.perReport;
        const reportBreakdown = pr
          ? ` · reports[eng=${pr.engagement.segments.toString()}s/${pr.engagement.applied.toString()}r dl=${pr.downloads.segments.toString()}s/${pr.downloads.applied.toString()}r sess=${pr.sessions.segments.toString()}s/${pr.sessions.applied.toString()}r crash=${pr.crashes.segments.toString()}s/${pr.crashes.applied.toString()}r]`
          : "";
        await publishProgress({
          jobId: input.jobId,
          current: i + 1,
          total: dates.length,
          step: `${date} ${merged} · analytics ${analyticsSummary?.hadData ? `dl=${analyticsSummary.downloads.toString()} pv=${analyticsSummary.pageViews.toString()} imp=${analyticsSummary.impressions.toString()} sess=${analyticsSummary.sessions.toString()}` : "empty"}${salesSummary ? ` · sales units=${salesSummary.units.toString()}` : ""} · funnel ${funnelRowsForDate.toString()}r${reportBreakdown}`,
        });
        if (i < dates.length - 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      await recordAudit({
        action: "aso.analytics.sync",
        target: `app:${app.id}`,
        outcome: daysWithData > 0 ? "SUCCESS" : "PARTIAL",
        appId: app.id,
        diff: {
          mode,
          daysProcessed: dates.length,
          daysWithData,
          salesDaysWithData,
          snapshotsWritten,
          funnelsWritten,
          firstDate: dates[0]!,
          lastDate: dates[dates.length - 1]!,
          requestIds,
          // Per-date diagnostics: when the job comes back with surprising
          // numbers, this lets ops see exactly which source contributed
          // what on each day (analytics-only, sales-only, merged, none).
          perDate,
        },
      });

      return {
        mode,
        daysProcessed: dates.length,
        daysWithData,
        snapshotsWritten,
        funnelsWritten,
        firstDate: dates[0]!,
        lastDate: dates[dates.length - 1]!,
      };
    },
  );
}

function resolveDateRange(input: AsoAnalyticsSyncInput): string[] {
  if (input.fromDate && input.toDate) {
    return enumerateDates(input.fromDate, input.toDate);
  }
  return [input.date ?? defaultYesterdayUtc()];
}

function enumerateDates(fromIso: string, toIso: string): string[] {
  const start = new Date(`${fromIso}T00:00:00.000Z`);
  const end = new Date(`${toIso}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new ValidationError(`Invalid date range ${fromIso} → ${toIso}`);
  }
  if (start > end) return [];
  // Hard cap at 365 days so a misconfigured caller can't issue thousands
  // of Apple requests.
  const days = Math.min(365, Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function upsertDailySnapshot(
  tenantId: string,
  appId: string,
  daily: {
    date: string;
    impressions: number;
    pageViews: number;
    downloads: number;
    firstTimeDownloads: number;
    redownloads: number;
    sessions: number;
    activeDevices1d: number;
    activeDevices7d: number;
    activeDevices30d: number;
    crashes: number;
  },
): Promise<void> {
  const pvcrPct = daily.pageViews > 0 ? (daily.downloads / daily.pageViews) * 100 : 0;
  const data = {
    impressions: daily.impressions,
    pageViews: daily.pageViews,
    downloads: daily.downloads,
    firstTimeDownloads: daily.firstTimeDownloads,
    redownloads: daily.redownloads,
    sessions: daily.sessions,
    activeDevices1d: daily.activeDevices1d,
    activeDevices7d: daily.activeDevices7d,
    activeDevices30d: daily.activeDevices30d,
    crashes: daily.crashes,
    pvcrPct,
  };
  await prisma.analyticsSnapshot.upsert({
    where: { appId_date: { appId, date: new Date(daily.date) } },
    create: { tenantId, appId, date: new Date(daily.date), ...data },
    update: data,
  });
}

async function upsertFunnelRow(
  tenantId: string,
  appId: string,
  row: {
    date: string;
    source: string;
    territory: string;
    impressions: number;
    pageViews: number;
    downloads: number;
  },
): Promise<void> {
  const pvcrPct = row.pageViews > 0 ? (row.downloads / row.pageViews) * 100 : 0;
  const data = {
    impressions: row.impressions,
    pageViews: row.pageViews,
    downloads: row.downloads,
    pvcrPct,
  };
  await prisma.analyticsFunnel.upsert({
    where: {
      appId_date_source_territory: {
        appId,
        date: new Date(row.date),
        source: row.source,
        territory: row.territory,
      },
    },
    create: {
      tenantId,
      appId,
      date: new Date(row.date),
      source: row.source,
      territory: row.territory,
      ...data,
    },
    update: data,
  });
}

/**
 * Sales Reports → AnalyticsSnapshot when Analytics Reports gave us
 * nothing for that day. We only know units (no impressions / page
 * views / sessions / active devices), so the engagement columns stay
 * 0 — the UI treats them as "not available" without dropping the row.
 * Device breakdown is persisted in rawJson so the Devices donut has
 * something to render.
 */
async function upsertSalesSnapshot(
  tenantId: string,
  appId: string,
  summary: {
    date: string;
    units: number;
    updates: number;
    perDevice: Map<string, number>;
    perTerritory: Map<string, number>;
  },
): Promise<void> {
  const devices: { device: string; units: number }[] = [];
  for (const [device, units] of summary.perDevice) devices.push({ device, units });
  const territories: { territory: string; units: number }[] = [];
  for (const [territory, units] of summary.perTerritory) territories.push({ territory, units });
  const raw = {
    source: "sales-reports" as const,
    devices,
    territories,
    updates: summary.updates,
  };
  await prisma.analyticsSnapshot.upsert({
    where: { appId_date: { appId, date: new Date(summary.date) } },
    create: {
      tenantId,
      appId,
      date: new Date(summary.date),
      impressions: 0,
      pageViews: 0,
      downloads: summary.units,
      firstTimeDownloads: summary.units,
      redownloads: 0,
      sessions: 0,
      activeDevices1d: 0,
      activeDevices7d: 0,
      activeDevices30d: 0,
      crashes: 0,
      pvcrPct: 0,
      rawJson: raw as object,
    },
    update: {
      downloads: summary.units,
      firstTimeDownloads: summary.units,
      rawJson: raw as object,
    },
  });
}

/**
 * When Analytics Reports already wrote the engagement row, merge in
 * Sales Reports' data. Two things happen:
 *
 *   1. Device + territory breakdown lands in `rawJson` so the Devices
 *      donut works without overwriting impressions / page views.
 *   2. If Analytics' `downloads` is 0 but Sales has units, the Sales
 *      number is patched in. This is the fresh-app failure mode: Apple
 *      ships App Sessions immediately but the App Downloads report
 *      can take 24-72 h to ramp up, so the daily rollup was written
 *      with downloads=0 even though Sales already knows the real units.
 *      We only fill IN — never OVERWRITE — so we don't clobber a
 *      perfectly good Analytics number with Sales (Analytics + Sales
 *      can diverge by a few units; Analytics is canonical when both
 *      have data).
 */
async function mergeSalesIntoSnapshot(
  appId: string,
  date: string,
  summary: {
    units: number;
    perDevice: Map<string, number>;
    perTerritory: Map<string, number>;
    updates: number;
  },
): Promise<void> {
  const devices: { device: string; units: number }[] = [];
  for (const [device, units] of summary.perDevice) devices.push({ device, units });
  const territories: { territory: string; units: number }[] = [];
  for (const [territory, units] of summary.perTerritory) territories.push({ territory, units });
  const raw = {
    source: "analytics+sales" as const,
    devices,
    territories,
    updates: summary.updates,
  };

  // Read the current row so we can decide whether to patch downloads.
  // Doing this in a single round-trip + conditional write keeps the
  // operation idempotent across re-runs of the same date.
  const existing = await prisma.analyticsSnapshot.findUnique({
    where: { appId_date: { appId, date: new Date(date) } },
    select: { downloads: true, firstTimeDownloads: true, pageViews: true },
  });

  const patch: {
    rawJson: object;
    downloads?: number;
    firstTimeDownloads?: number;
    pvcrPct?: number;
  } = { rawJson: raw as object };

  if (existing?.downloads === 0 && summary.units > 0) {
    patch.downloads = summary.units;
    patch.firstTimeDownloads = summary.units;
    // Recompute pvcrPct so the conversion chart isn't stuck at 0
    // when Sales fills in the downloads.
    patch.pvcrPct = existing.pageViews > 0 ? (summary.units / existing.pageViews) * 100 : 0;
  }

  await prisma.analyticsSnapshot.updateMany({
    where: { appId, date: new Date(date) },
    data: patch,
  });
}

function defaultYesterdayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ──────────────────────────────────────────────────────────────────────
// aso.astro.analyze — smart Astro autopilot sync + recommendations
// ──────────────────────────────────────────────────────────────────────

export interface AsoAstroAnalyzeInput {
  jobId: string;
  tenantId: string;
  userId: string;
  appId: string;
  locales?: string[];
  includeCompetitorMining?: boolean;
  skipEmptyTerritories?: boolean;
  maxProposalsPerLocale?: number;
  maxAutoSwapsPerLocale?: number;
  minStrengthDelta?: number;
  enrichWithMetrics?: boolean;
  minPopularity?: number;
  maxDifficulty?: number;
}

/**
 * Astro autopilot — registers the app in Astro, pushes our tracked
 * keywords per storefront (rate-limited to Astro's 30 req/min), then
 * mines stronger alternatives via `get_keyword_suggestions` (and
 * optionally `extract_competitors_keywords`).
 *
 * Long-running (can take minutes for multi-locale apps under rate
 * limit), which is exactly why this runs as a background job rather
 * than blocking an HTTP request. The result is persisted on `Job.result`
 * so the UI can render it after page refresh until the next re-run.
 */
export async function processAsoAstroAnalyze(input: AsoAstroAnalyzeInput): Promise<
  AnalyzeResult & {
    endpoint: string;
    /** When the run targeted specific locales, this is the requested
     *  filter. When omitted, the run covered every locale with tracked
     *  keywords. Used by the UI to merge partial (per-locale) runs with
     *  prior full-app snapshots without clobbering untouched locales. */
    targetLocales: string[] | null;
    recommendationsByLocale: {
      locale: string;
      territory: string;
      currentKeywordsField: string;
      proposals: AnalyzeResult["recommendationsByTerritory"][number]["proposals"];
      diagnostics: AnalyzeResult["recommendationsByTerritory"][number]["diagnostics"] | null;
    }[];
    /** Whether the AI relevance scorer ran successfully during this
     *  analyze. When `available: false`, the autopilot UI surfaces a
     *  "Relevance filter offline" warning badge so users know
     *  proposals may include cross-category noise. */
    aiRelevanceStatus: {
      available: boolean;
      lastError?: string;
    };
  }
> {
  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      // Defense-in-depth: scope by the job's tenantId too. The appId comes
      // from the (untrusted) job payload; pairing it with tenantId rejects a
      // cross-tenant appId even if RLS were ever disabled/misconfigured.
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");
      if (app.platform !== "IOS") {
        throw new ValidationError("aso.astro.analyze currently supports IOS only");
      }

      const loaded = await loadAstroAutopilotForTenant(input.tenantId);
      if (!loaded) {
        throw new ValidationError(
          "No Astro MCP credential configured. Connect Astro under Settings → Credentials.",
        );
      }

      await publishProgress({
        jobId: input.jobId,
        current: 0,
        total: 1,
        step: "Loading app + tracked keywords…",
      });

      // Locales + tracked keywords + latest signal — same shape as the
      // synchronous endpoint, kept in sync with apps/web/src/app/api/v1
      // /apps/[id]/aso/astro/analyze/route.ts.
      const locWhere: { appId: string; locale?: { in: string[] } } = { appId: input.appId };
      if (input.locales && input.locales.length > 0) {
        locWhere.locale = { in: input.locales };
      }
      const [localizations, trackedRows] = await Promise.all([
        prisma.appLocalization.findMany({
          where: locWhere,
          // Pull full metadata: needed for the AI relevance scorer's
          // cross-locale grounding (Phase 2). The keywords field is
          // still used for the inField check; everything else feeds
          // the prompt's `allLocalesMetadata` bundle.
          select: {
            locale: true,
            keywords: true,
            name: true,
            subtitle: true,
            promotionalText: true,
            description: true,
          },
        }),
        prisma.trackedKeyword.findMany({
          where: { appId: input.appId, status: "ACTIVE" },
          select: {
            id: true,
            keyword: true,
            territory: true,
            signals: {
              orderBy: { date: "desc" },
              take: 1,
              select: {
                score: true,
                appStoreRank: true,
                bucket: true,
                volume: true,
                maxVolume: true,
                difficulty: true,
                maxReachChance: true,
              },
            },
          },
          take: 3000,
        }),
      ]);

      const parseKeywordsField = (raw: string | null | undefined): string[] => {
        if (!raw) return [];
        return Array.from(
          new Set(
            raw
              .split(",")
              .map((t) => t.trim().replace(/\s+/g, " "))
              .filter((t) => t.length >= 2 && t.length <= 80),
          ),
        );
      };

      const { localeRegion } = await import("@marquee/core");

      const territoryByLocale = new Map<string, string>();
      for (const loc of localizations) {
        territoryByLocale.set(loc.locale, localeRegion(loc.locale));
      }
      const uniqueTerritories = [...new Set(territoryByLocale.values())];

      const local: LocalTrackedKeyword[] = trackedRows.map((t) => {
        const sig = t.signals[0];
        const inField = localizations.some((loc) => {
          if (territoryByLocale.get(loc.locale) !== t.territory) return false;
          const tokens = parseKeywordsField(loc.keywords);
          return tokens.some((tok) => tok.toLowerCase() === t.keyword.toLowerCase());
        });
        return {
          id: t.id,
          keyword: t.keyword,
          territory: t.territory,
          score: sig?.score != null ? Number(sig.score) : null,
          bucket: sig?.bucket ?? null,
          rank: sig?.appStoreRank ?? null,
          inField,
          volume: sig?.volume ?? null,
          difficulty: sig?.difficulty ?? null,
          maxReachChance: sig?.maxReachChance ?? null,
        };
      });

      const autopilotApp: AutopilotApp = {
        id: app.id,
        appName: app.appName,
        bundleId: app.bundleId,
        store: "ios",
        storeAppId: app.storeAppId,
      };

      // Compute how many territories we'll actually visit so the
      // progress bar has a meaningful denominator. The autopilot
      // skips empties by default.
      const skipEmpty = input.skipEmptyTerritories ?? true;
      const territoriesToRun = skipEmpty
        ? uniqueTerritories.filter((t) =>
            local.some((k) => k.territory.toUpperCase() === t.toUpperCase()),
          )
        : uniqueTerritories;

      await publishProgress({
        jobId: input.jobId,
        current: 0,
        total: Math.max(territoriesToRun.length, 1),
        step: `Registering app in Astro · ${territoriesToRun.length.toString()} storefronts queued`,
      });

      // Build territory → locale map so the autopilot's candidate
      // scorer can apply a per-language preference. Multiple locales
      // can share a territory (en-US + en-CA → US); we pick the FIRST
      // locale we see for each territory — for monolingual storefronts
      // (CZ, JP, KR, …) that's exactly what we want; for English-shared
      // ones the locale-language hint resolves to "en" either way.
      const territoryLocaleMap: Record<string, string> = {};
      for (const [locale, territory] of territoryByLocale.entries()) {
        if (!territoryLocaleMap[territory]) {
          territoryLocaleMap[territory] = locale;
        }
      }

      // Build an AI enricher closure for non-English locales. Astro's
      // mining pool is dominated by English even in Czech / Polish /
      // Hungarian markets (Czech App Store competitors mostly use
      // English keywords) so we plug in the tenant's AI orchestrator
      // to transcreate top Astro seeds into locale-language candidates.
      const aiOrchestrator = await loadAiOrchestratorForTenant(input.tenantId);
      const { buildKeywordSuggestTask, buildKeywordRelevanceTask } = await import("@marquee/aso");
      const { localeName } = await import("@marquee/core");

      // Build the cross-locale metadata bundle once per analyze run.
      // Phase 2: feeds the AI relevance scorer so every locale's
      // candidates are graded against the global app pitch — not just
      // that one locale's text. Description truncated server-side to
      // keep the prompt budget predictable.
      const allLocalesMetadataBundle = localizations.map((l) => ({
        locale: l.locale,
        isPrimary: l.locale === app.primaryLocale,
        title: l.name ?? null,
        subtitle: l.subtitle ?? null,
        keywordsField: l.keywords ?? null,
        promotionalText: l.promotionalText ?? null,
        description: l.description ? l.description.trim().slice(0, 600) : null,
      }));
      // ── AI relevance scorer ────────────────────────────────────
      // Rates each candidate's fit to THIS app's actual game/category.
      // Drops candidates from unrelated app categories Astro pulled in
      // by frequency-only mining (e.g. "saw → sniper games" for a
      // block-breaker app). Runs for every locale, not just non-English.
      //
      // Caching: each (appId × keyword × locale) relevance score lives
      // in AiRelevanceCache for 30 days. Cache hits cost zero tokens;
      // we only ask the AI about candidates we haven't seen. Status is
      // tracked so the analyze result tells the UI whether the
      // relevance filter actually ran or was unavailable.
      const RELEVANCE_CACHE_TTL_DAYS = 30;
      const cacheCutoff = new Date();
      cacheCutoff.setUTCDate(cacheCutoff.getUTCDate() - RELEVANCE_CACHE_TTL_DAYS);
      const aiStatus: { available: boolean; lastError: string | null } = {
        available: aiOrchestrator != null,
        lastError: null,
      };
      const aiRelevanceScorer: AiRelevanceScorer | undefined = aiOrchestrator
        ? async (info: AiRelevanceScorerInput): Promise<AiRelevanceScorerOutput> => {
            // 1. Pull cached scores for this app + locale that are still
            //    within TTL. Bumping `hitCount` lets us audit savings.
            const candidateKeywords = info.candidates.map((c) => c.keyword);
            const cached = await prisma.aiRelevanceCache.findMany({
              where: {
                appId: input.appId,
                locale: info.localeCode,
                keyword: { in: candidateKeywords },
                scoredAt: { gte: cacheCutoff },
              },
              select: { keyword: true, relevance: true, reason: true },
            });
            const cachedByKey = new Map(cached.map((c) => [c.keyword.toLowerCase(), c]));
            const uncached = info.candidates.filter(
              (c) => !cachedByKey.has(c.keyword.toLowerCase()),
            );

            // 2. Score only the uncached residue via AI.
            const freshScores: {
              keyword: string;
              relevance: number;
              reason: string | null;
            }[] = [];
            if (uncached.length > 0) {
              const task = buildKeywordRelevanceTask({
                appName: info.app.appName,
                primaryGenre: info.app.primaryGenre,
                bundleId: info.app.bundleId,
                localeCode: info.localeCode,
                storeCode: info.storeCode,
                ...(info.currentMetadata && { currentMetadata: info.currentMetadata }),
                // Cross-locale bundle (Phase 2): when present the
                // scorer uses it as the source of truth instead of
                // the single-locale `currentMetadata` block.
                ...(allLocalesMetadataBundle.length > 0 && {
                  allLocalesMetadata: allLocalesMetadataBundle,
                }),
                candidates: uncached,
              });
              const result = await aiOrchestrator.run(task);
              if (!result.ok) {
                // Don't drop the candidates silently — flag the AI as
                // unavailable so the autopilot UI can warn the user
                // that proposals may include cross-category noise.
                aiStatus.available = false;
                aiStatus.lastError = result.message ?? "AI relevance scorer failed";
              } else {
                for (const s of result.output.scores as {
                  keyword: string;
                  relevance: number;
                  reason: string | null;
                }[]) {
                  freshScores.push({
                    keyword: s.keyword,
                    relevance: s.relevance,
                    reason: s.reason,
                  });
                }
                // Persist fresh scores so future runs hit the cache.
                for (const s of freshScores) {
                  try {
                    await prisma.aiRelevanceCache.upsert({
                      where: {
                        appId_keyword_locale: {
                          appId: input.appId,
                          keyword: s.keyword,
                          locale: info.localeCode,
                        },
                      },
                      create: {
                        tenantId: input.tenantId,
                        appId: input.appId,
                        keyword: s.keyword,
                        locale: info.localeCode,
                        relevance: s.relevance,
                        reason: s.reason,
                      },
                      update: {
                        relevance: s.relevance,
                        reason: s.reason,
                        scoredAt: new Date(),
                      },
                    });
                  } catch {
                    // Cache miss writes are non-fatal — score still
                    // returns to the autopilot.
                  }
                }
              }
            }

            // 3. Bump hit counters for cached rows (audit signal).
            if (cached.length > 0) {
              try {
                await prisma.aiRelevanceCache.updateMany({
                  where: {
                    appId: input.appId,
                    locale: info.localeCode,
                    keyword: { in: cached.map((c) => c.keyword) },
                  },
                  data: { hitCount: { increment: 1 } },
                });
              } catch {
                /* counter bump is best-effort */
              }
            }

            // 4. Merge cached + fresh scores into one output array.
            const allScores = [
              ...cached.map((c) => ({
                keyword: c.keyword,
                relevance: c.relevance,
                reason: c.reason,
              })),
              ...freshScores,
            ];
            return { scores: allScores };
          }
        : undefined;

      // Build per-locale metadata map so the relevance scorer sees the
      // actual product copy for each storefront — not just the app name.
      // We already fetch title/subtitle/promo/description above for the
      // cross-locale grounding bundle; pass them through here too so the
      // per-candidate scoring has real product context.
      const currentMetadataByLocale: Record<
        string,
        {
          title: string | null;
          subtitle: string | null;
          keywordsField: string | null;
          promotionalText: string | null;
          description: string | null;
        }
      > = {};
      for (const loc of localizations) {
        currentMetadataByLocale[loc.locale] = {
          title: loc.name ?? null,
          subtitle: loc.subtitle ?? null,
          keywordsField: loc.keywords,
          promotionalText: loc.promotionalText ?? null,
          // Truncate description to 600 chars — same budget the cross-
          // locale bundle uses. Keeps the relevance prompt bounded.
          description: loc.description ? loc.description.trim().slice(0, 600) : null,
        };
      }

      // ── Build app-metadata mining seeds, keyed by locale ────────
      // For each locale we have an AppLocalization for, derive a small
      // pool (≤6) of distinctive nouns from name + subtitle + promo +
      // first-N words of description. These get folded into the Astro
      // mining seed pool inside proposeSwaps so the recommendation
      // panel ALWAYS has app-relevant seeds to start from — even when
      // the app has zero tracked keywords in this territory yet.
      //
      // Selection rules:
      //   • lowercase, 3-30 chars
      //   • strip stop words + obvious ASO noise ("game", "app", "free")
      //   • dedup against the locale's existing keywords field (those
      //     are already used as Astro mining seeds — no point repeating)
      //   • cap at 6 per locale to keep the autopilot's seed budget
      //     focused on the strongest signals
      const METADATA_SEED_STOPWORDS = new Set([
        "the",
        "a",
        "an",
        "and",
        "or",
        "of",
        "for",
        "in",
        "on",
        "at",
        "to",
        "with",
        "by",
        "from",
        "as",
        "is",
        "are",
        "be",
        "was",
        "were",
        "this",
        "that",
        "you",
        "your",
        "our",
        "we",
        "i",
        "me",
        "my",
        "it",
        "its",
        "into",
        "out",
        "up",
        "down",
        // ASO-universal noise we never want to mine on
        "game",
        "games",
        "app",
        "apps",
        "free",
        "best",
        "new",
        "pro",
        "play",
        "fun",
        "now",
        "top",
        "no",
        "yes",
        "all",
        "more",
      ]);
      const tokeniseMetadataField = (raw: string | null | undefined): string[] => {
        if (!raw) return [];
        return raw
          .toLowerCase()
          .split(/[\s,;.!?:/()[\]{}"'`«»“”‘’—–-]+/u)
          .map((w) => w.replace(/[^\p{Letter}\p{Number}]/gu, ""))
          .filter((w) => w.length >= 3 && w.length <= 30)
          .filter((w) => !METADATA_SEED_STOPWORDS.has(w));
      };
      const appNameTokens = tokeniseMetadataField(app.appName);
      const appMetadataSeedsByLocale: Record<string, string[]> = {};
      for (const loc of localizations) {
        // Description is the noisiest source — clip to first ~30 tokens
        // so we don't blow the seed pool out with random sentence bits.
        const descTokens = tokeniseMetadataField(loc.description).slice(0, 30);
        const existingFieldTokens = new Set(
          (loc.keywords ?? "")
            .toLowerCase()
            .split(/[,\s]+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        );
        // Order matters: title + subtitle are highest-signal; description
        // tokens are filler used only if we still have budget left.
        const candidates = [
          ...tokeniseMetadataField(loc.name),
          ...tokeniseMetadataField(loc.subtitle),
          ...tokeniseMetadataField(loc.promotionalText),
          ...descTokens,
        ];
        const seen = new Set<string>();
        const seeds: string[] = [];
        for (const tok of candidates) {
          if (seen.has(tok)) continue;
          if (existingFieldTokens.has(tok)) continue;
          // Skip generic single-letter or app-name tokens — those add
          // no information and Astro mining returns nothing useful.
          if (appNameTokens.includes(tok) && tok.length <= 4) continue;
          seen.add(tok);
          seeds.push(tok);
          if (seeds.length >= 6) break;
        }
        if (seeds.length > 0) {
          appMetadataSeedsByLocale[loc.locale] = seeds;
        }
      }

      const aiEnricher: AiEnricher | undefined = aiOrchestrator
        ? async (info: AiEnricherInput): Promise<AiEnricherOutput> => {
            const languageName = localeName(info.localeCode);
            const task = buildKeywordSuggestTask({
              appName: info.app.appName,
              primaryLocale: info.localeCode,
              territories: [info.storeCode.toUpperCase()],
              primaryGenre: info.app.primaryGenre,
              shortDescription: null,
              longDescription: null,
              existingKeywords: [
                ...info.existingKeywords,
                // Treat Astro's English pool as "already tracked" so the
                // AI doesn't echo them — we want NEW locale-language
                // alternatives that exploit the same competitive pocket.
                ...info.astroSeeds.map((s) => s.keyword),
              ],
              count: info.count,
            });
            // Append a sharp language directive so the model doesn't
            // default to English even when the existingKeywords pool
            // is all English. Same trick the ai-keywords route uses.
            const directive = `\n\nIMPORTANT: every suggestion MUST be written in ${languageName} (locale ${info.localeCode}). Treat the existingKeywords list as the competitor cluster you are competing with — generate ${info.count.toString()} fresh, locale-native keywords that target the same ASO intent but in ${languageName}. Transliterate brand-borrowed terms correctly. No English unless this is an English locale.`;
            const localePrompt: typeof task = {
              ...task,
              userPrompt: task.userPrompt + directive,
            };
            const result = await aiOrchestrator.run(localePrompt);
            if (!result.ok) return { candidates: [] };
            return {
              candidates: result.output.suggestions.map(
                (s: { keyword: string; rationale: string; predictedRelevance: number }) => ({
                  keyword: s.keyword,
                  popularity: s.predictedRelevance,
                  cluster: "LOCALE_AI",
                  reason: s.rationale,
                }),
              ),
            };
          }
        : undefined;

      // Pull the per-tenant learned-noise set (terms the user has
      // rejected ≥3 times in the past 6 months). Eviction window keeps
      // the set fresh — a term rejected a year ago shouldn't keep
      // filtering proposals if user sentiment may have shifted.
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
      const learnedNoiseRows = await prisma.learnedNoiseTerm.findMany({
        where: {
          rejectCount: { gte: 3 },
          lastRejectedAt: { gte: sixMonthsAgo },
        },
        select: { term: true },
      });
      const learnedNoiseTerms = new Set(learnedNoiseRows.map((r) => r.term.toLowerCase().trim()));

      const result = await loaded.autopilot.analyze(autopilotApp, local, {
        territories: uniqueTerritories,
        territoryLocaleMap,
        currentMetadataByLocale,
        ...(Object.keys(appMetadataSeedsByLocale).length > 0 && {
          appMetadataSeedsByLocale,
        }),
        ...(learnedNoiseTerms.size > 0 && { learnedNoiseTerms }),
        ...(aiEnricher && { aiEnricher }),
        ...(aiRelevanceScorer && { aiRelevanceScorer }),
        skipEmptyTerritories: skipEmpty,
        includeCompetitorMining: input.includeCompetitorMining ?? false,
        ...(input.maxProposalsPerLocale !== undefined && {
          maxProposalsPerLocale: input.maxProposalsPerLocale,
        }),
        ...(input.maxAutoSwapsPerLocale !== undefined && {
          maxAutoSwapsPerLocale: input.maxAutoSwapsPerLocale,
        }),
        ...(input.minStrengthDelta !== undefined && {
          minStrengthDelta: input.minStrengthDelta,
        }),
        ...(input.enrichWithMetrics !== undefined && {
          enrichWithMetrics: input.enrichWithMetrics,
        }),
        ...(input.minPopularity !== undefined && { minPopularity: input.minPopularity }),
        // Authority-tier aware difficulty cap. When the caller passed
        // a custom value, honor it (clamped to [10, 95]); otherwise
        // derive from the app's latest 30-day active devices so a new
        // app doesn't see unreachable difficulty-80 candidates.
        maxDifficulty: await (async (): Promise<number> => {
          const { resolveMaxDifficulty } = await import("@marquee/aso");
          const latestSnap = await prisma.analyticsSnapshot.findFirst({
            where: { appId: input.appId },
            orderBy: { date: "desc" },
            select: { activeDevices30d: true },
          });
          return resolveMaxDifficulty(
            latestSnap?.activeDevices30d ?? null,
            input.maxDifficulty ?? null,
          );
        })(),
        // Emit per-territory progress so the UI's poll loop has a
        // meaningful "Analysing US (3/10)…" status instead of a frozen
        // spinner over a 2-minute rate-limited run.
        onTerritoryStart: async ({ index, total, territory }) => {
          await publishProgress({
            jobId: input.jobId,
            current: index,
            total: Math.max(total, 1),
            step: `Analysing ${territory} (${(index + 1).toString()}/${total.toString()})`,
          });
        },
      });

      await publishProgress({
        jobId: input.jobId,
        current: territoriesToRun.length,
        total: Math.max(territoriesToRun.length, 1),
        step: `Synced · ${result.totals.proposals.toString()} proposals`,
      });

      // Project per-territory recommendations onto per-locale rows so
      // the UI matches a locale to its proposals 1:1 (multiple locales
      // can share a territory).
      const recsByTerritory = new Map<
        string,
        AnalyzeResult["recommendationsByTerritory"][number]
      >();
      for (const r of result.recommendationsByTerritory) {
        recsByTerritory.set(r.territory, r);
      }
      const recommendationsByLocale = localizations.map((loc) => {
        const territory = territoryByLocale.get(loc.locale) ?? localeRegion(loc.locale);
        const rec = recsByTerritory.get(territory);
        return {
          locale: loc.locale,
          territory,
          currentKeywordsField: loc.keywords ?? "",
          proposals: rec?.proposals ?? [],
          diagnostics: rec?.diagnostics ?? null,
        };
      });

      // ── Persist Astro signals as KeywordSignal rows ──────────────
      // Astro is the single source of truth for keyword signals — see
      // docs/16_ASO_INTELLIGENCE.md. The legacy `aso.keywords.refresh`
      // job (which fanned out to Apple Search Ads + Google Trends +
      // iTunes Search) has been retired. Instead we read Astro's view
      // of the app's tracked keywords here and upsert one KeywordSignal
      // row per (trackedKeyword × today). The score + bucket are
      // recomputed from Astro signals via `keywordScore`.
      let signalsWritten = 0;
      try {
        if (app.storeAppId) {
          const astroKeywords = await loaded.autopilot.client.getAppKeywords({
            appId: app.storeAppId,
          });
          // Index Astro's rows by (keyword × territory) so we can match
          // them back to our local TrackedKeyword UUIDs.
          const astroByKey = new Map<string, (typeof astroKeywords)[number]>();
          for (const kw of astroKeywords) {
            const territory = typeof kw.country === "string" ? kw.country.toUpperCase() : null;
            if (!territory) continue;
            astroByKey.set(`${kw.keyword.toLowerCase()}|${territory}`, kw);
          }

          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);

          for (const tracked of local) {
            const astroRow = astroByKey.get(
              `${tracked.keyword.toLowerCase()}|${tracked.territory.toUpperCase()}`,
            );
            if (!astroRow) continue;
            // Astro `getAppKeywords` returns popularity / difficulty /
            // rank on the AstroTrackedKeyword shape. Volume scale is
            // Apple's 0-100, so we set maxVolume to 100 explicitly.
            const popularity = typeof astroRow.popularity === "number" ? astroRow.popularity : null;
            const difficulty = typeof astroRow.difficulty === "number" ? astroRow.difficulty : null;
            const ranking = typeof astroRow.rank === "number" ? astroRow.rank : null;
            const maxReach =
              typeof astroRow.maxReachChance === "number" ? astroRow.maxReachChance : null;
            // Pass keyword + locale so the persisted score matches what
            // AstroAutopilot.scoreAstroCandidate would produce for the
            // same row — multi-word boost + language-match multiplier
            // are applied uniformly post the 2026-05 scoring audit.
            const localeForScoring = territoryLocaleMap[tracked.territory] ?? null;
            const { score, bucket } = keywordScore({
              appStoreRank: ranking,
              volume: popularity,
              maxVolume: popularity != null ? 100 : null,
              difficulty,
              maxReachChance: maxReach,
              keyword: tracked.keyword,
              ...(localeForScoring && { localeHint: localeForScoring }),
            });
            try {
              await prisma.keywordSignal.upsert({
                where: {
                  trackedKeywordId_date: {
                    trackedKeywordId: tracked.id,
                    date: today,
                  },
                },
                create: {
                  tenantId: input.tenantId,
                  trackedKeywordId: tracked.id,
                  date: today,
                  appStoreRank: ranking,
                  volume: popularity,
                  maxVolume: popularity != null ? 100 : null,
                  difficulty,
                  maxReachChance: maxReach,
                  score,
                  bucket,
                },
                update: {
                  appStoreRank: ranking,
                  volume: popularity,
                  maxVolume: popularity != null ? 100 : null,
                  difficulty,
                  maxReachChance: maxReach,
                  score,
                  bucket,
                },
              });
              signalsWritten++;
            } catch {
              // Per-keyword upsert failures are non-fatal — keep going
              // so one bad row doesn't sink the whole signal snapshot.
            }
          }

          // ── Temporal bucket overlay ─────────────────────────────
          // After today's row is written, look back 7 days per tracked
          // keyword and detect RISING / FALLING. The temporal bucket
          // OVERRIDES today's bucket (except for CHAMPION + DECAY,
          // which `applyTemporalOverride` protects). Persisted to the
          // same KeywordSignal row so the UI surfaces it everywhere
          // without re-deriving on every render.
          const sevenDaysAgo = new Date(today);
          sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
          for (const tracked of local) {
            try {
              const history = await prisma.keywordSignal.findMany({
                where: {
                  trackedKeywordId: tracked.id,
                  date: { gte: sevenDaysAgo, lte: today },
                },
                select: { date: true, score: true, appStoreRank: true, bucket: true },
                orderBy: { date: "asc" },
              });
              if (history.length < 3) continue;
              const temporal = temporalBucket(
                history.map((h) => ({
                  date: h.date.toISOString().slice(0, 10),
                  score: h.score != null ? Number(h.score) : null,
                  appStoreRank: h.appStoreRank,
                })),
              );
              if (!temporal) continue;
              const todayRow = history[history.length - 1];
              if (!todayRow) continue;
              const overrideBucket = applyTemporalOverride(todayRow.bucket, temporal);
              if (overrideBucket && overrideBucket !== todayRow.bucket) {
                await prisma.keywordSignal.updateMany({
                  where: { trackedKeywordId: tracked.id, date: today },
                  data: { bucket: overrideBucket },
                });
              }
            } catch {
              // Temporal layer is best-effort — a per-keyword failure
              // shouldn't sink the analyze.
            }
          }
        }
      } catch {
        // Astro signal snapshot is a side-effect, not the primary
        // analyze deliverable. If it fails we still return proposals.
      }

      await recordAudit({
        action: "aso.astro.analyzed",
        target: `app:${input.appId}`,
        outcome: "SUCCESS",
        appId: input.appId,
        diff: {
          territories: result.syncByTerritory.length,
          added: result.totals.added,
          proposals: result.totals.proposals,
          durationMs: result.durationMs,
          signalsWritten,
        },
      });

      return {
        ...result,
        endpoint: loaded.endpoint,
        targetLocales: input.locales ?? null,
        recommendationsByLocale,
        // Transparency signal — when the AI relevance scorer failed
        // during this run, the UI surfaces a "Relevance filter offline"
        // badge on the autopilot banner so the user knows proposals
        // may include cross-category noise.
        aiRelevanceStatus: {
          available: aiStatus.available,
          ...(aiStatus.lastError && { lastError: aiStatus.lastError }),
        },
      };
    },
  );
}

// ─────────────────────────────────────────────────────────────────────
// aso.daily-check processor — runs the alarm engine + analyst for one
// app on one day, persists AsoDailyCheck + AsoNotification rows.
//
// Mirrors apps/web/src/lib/asoDailyCheck.ts so the same orchestration
// can run from BullMQ (scheduled nightly fan-out) OR synchronously
// from the Next.js route handler. Kept here in the worker so the
// nightly cron path doesn't need to go through HTTP at all.
// ─────────────────────────────────────────────────────────────────────

export interface AsoDailyCheckInput {
  tenantId: string;
  userId?: string | null;
  appId: string;
  /** YYYY-MM-DD. Defaults to today UTC. */
  date?: string;
  recentChanges?: string;
  withAnalyst?: boolean;
}

export async function processAsoDailyCheck(input: AsoDailyCheckInput): Promise<{
  checkId: string;
  date: string;
  overallSeverity: "info" | "warning" | "danger" | "calm";
  counts: { danger: number; warning: number; info: number };
  notificationsCreated: number;
  analystRan: boolean;
}> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId ?? "00000000-0000-0000-0000-000000000000",
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
      });
      if (!app) throw new NotFoundError("App not found");

      const yesterday = subtractDays(date, 1);
      const baseline7d = subtractDays(date, 7);

      // ── Mark RUNNING ─────────────────────────────────────────
      const running = await prisma.asoDailyCheck.upsert({
        where: { appId_date: { appId: input.appId, date: new Date(date) } },
        create: {
          tenantId: input.tenantId,
          appId: input.appId,
          date: new Date(date),
          status: "RUNNING",
          reviewedById: input.userId ?? null,
        },
        update: { status: "RUNNING" },
      });

      try {
        // ── Keyword deltas ────────────────────────────────────
        const trackedKeywords = await prisma.trackedKeyword.findMany({
          where: { appId: input.appId, status: "ACTIVE" },
        });
        const trackedKeywordIds = trackedKeywords.map((k) => k.id);

        const signals = await prisma.keywordSignal.findMany({
          where: {
            trackedKeywordId: { in: trackedKeywordIds },
            date: { in: [new Date(date), new Date(yesterday)] },
          },
        });
        const signalIdx = new Map<string, Map<string, (typeof signals)[number]>>();
        for (const s of signals) {
          const dateKey = s.date.toISOString().slice(0, 10);
          const slot = signalIdx.get(s.trackedKeywordId) ?? new Map();
          slot.set(dateKey, s);
          signalIdx.set(s.trackedKeywordId, slot);
        }

        const keywordDeltas: KeywordRankDelta[] = trackedKeywords.map((k) => {
          const today = signalIdx.get(k.id)?.get(date) ?? null;
          const prev = signalIdx.get(k.id)?.get(yesterday) ?? null;
          return {
            trackedKeywordId: k.id,
            keyword: k.keyword,
            territory: k.territory,
            rankToday: today?.appStoreRank ?? null,
            rankYesterday: prev?.appStoreRank ?? null,
            bucketToday: today?.bucket ?? null,
            bucketYesterday: prev?.bucket ?? null,
            scoreToday: today?.score != null ? Number(today.score) : null,
            scoreYesterday: prev?.score != null ? Number(prev.score) : null,
            temporal: null,
            tags: k.tags.map((t) => t.toLowerCase()),
          };
        });

        // ── Competitor deltas ─────────────────────────────────
        const competitors = await prisma.competitor.findMany({
          where: { appId: input.appId, monitor: true },
        });
        const competitorIds = competitors.map((c) => c.id);

        const competitorRanks = await prisma.competitorRank.findMany({
          where: {
            competitorId: { in: competitorIds },
            date: { in: [new Date(date), new Date(yesterday)] },
          },
          include: { trackedKeyword: { select: { id: true, keyword: true } } },
        });
        const compIdx = new Map<
          string,
          { today?: (typeof competitorRanks)[number]; prev?: (typeof competitorRanks)[number] }
        >();
        for (const r of competitorRanks) {
          const key = `${r.competitorId}|${r.trackedKeywordId}`;
          const slot = compIdx.get(key) ?? {};
          if (r.date.toISOString().slice(0, 10) === date) slot.today = r;
          else slot.prev = r;
          compIdx.set(key, slot);
        }

        const ourRankByKw = new Map<string, number | null>();
        for (const k of trackedKeywords) {
          ourRankByKw.set(k.id, signalIdx.get(k.id)?.get(date)?.appStoreRank ?? null);
        }

        const competitorDeltas: CompetitorRankDelta[] = [];
        for (const [key, slot] of compIdx.entries()) {
          const [competitorId, trackedKeywordId] = key.split("|");
          if (!competitorId || !trackedKeywordId) continue;
          const competitor = competitors.find((c) => c.id === competitorId);
          const r = slot.today ?? slot.prev;
          if (!competitor || !r) continue;
          competitorDeltas.push({
            competitorId,
            competitorName: competitor.appName,
            trackedKeywordId,
            keyword: r.trackedKeyword.keyword,
            rankToday: slot.today?.rank ?? null,
            rankYesterday: slot.prev?.rank ?? null,
            ourRankToday: ourRankByKw.get(trackedKeywordId) ?? null,
          });
        }

        // ── Conversion delta from AnalyticsSnapshot ───────────
        const snapshots = await prisma.analyticsSnapshot.findMany({
          where: {
            appId: input.appId,
            date: { gte: new Date(baseline7d), lte: new Date(date) },
          },
          orderBy: { date: "desc" },
        });
        const snapToday = snapshots.find((s) => s.date.toISOString().slice(0, 10) === date);
        const snapYesterday = snapshots.find(
          (s) => s.date.toISOString().slice(0, 10) === yesterday,
        );
        const baseline = snapshots.filter((s) => s.date.toISOString().slice(0, 10) !== date);

        const conversion: ConversionDelta | undefined =
          snapToday && baseline.length > 0
            ? {
                cvrToday: snapToday.pvcrPct != null ? Number(snapToday.pvcrPct) : null,
                cvrBaseline: avg(
                  baseline.map((s) => (s.pvcrPct != null ? Number(s.pvcrPct) : null)),
                ),
                impressionsToday: snapToday.impressions,
                impressionsBaseline: Math.round(avg(baseline.map((s) => s.impressions)) ?? 0),
                downloadsToday: snapToday.downloads,
                downloadsBaseline: Math.round(avg(baseline.map((s) => s.downloads)) ?? 0),
              }
            : undefined;

        const alarmInput: AlarmEvaluationInput = {
          keywordDeltas,
          competitorDeltas,
          conversion,
        };

        // Adopted-vs-default performance — pure summary over today's
        // keywordDeltas. Feeds the analyst input + (later) the daily
        // check UI widget. Cheap: O(n) over tracked keywords.
        const { summariseAdoptedPerformance } = await import("@marquee/aso");
        const adoptedSummary = summariseAdoptedPerformance({
          rows: keywordDeltas.map((d) => ({
            trackedKeywordId: d.trackedKeywordId,
            rankToday: d.rankToday,
            tags: d.tags,
          })),
        });

        const analystBase: Omit<AsoAnalystDailyInput, "alarms"> = {
          appName: app.appName,
          bundleId: app.bundleId,
          platform: app.platform,
          primaryLocale: app.primaryLocale,
          primaryGenre: null,
          metrics: buildAnalystMetricsLocal(date, snapToday, snapYesterday, baseline),
          keywordHighlights: pickKeywordHighlights(keywordDeltas),
          competitorHighlights: pickCompetitorHighlights(competitorDeltas),
          recentChanges: input.recentChanges ?? null,
          adoptedPerformance: {
            adoptedCount: adoptedSummary.adoptedTotal,
            defaultCount: adoptedSummary.defaultTotal,
            adoptedAvgRank: adoptedSummary.adoptedAvgRank,
            defaultAvgRank: adoptedSummary.defaultAvgRank,
            verdict: adoptedSummary.verdict,
          },
        };

        let runAnalyst:
          | ((i: AsoAnalystDailyInput) => Promise<AsoAnalystDailyOutput | null>)
          | undefined;
        let analystRan = false;
        if (input.withAnalyst !== false) {
          try {
            const orchestrator = await loadAiOrchestratorForTenant(input.tenantId);
            if (orchestrator) {
              runAnalyst = async (analystInput) => {
                const task = buildAsoAnalystDailyTask(analystInput);
                const result = await orchestrator.run(task);
                if (result.ok) {
                  analystRan = true;
                  return result.output;
                }
                return null;
              };
            }
          } catch {
            runAnalyst = undefined;
          }
        }

        const result = await runDailyCheck({
          appId: input.appId,
          date,
          alarmInput,
          analystInputBase: analystBase,
          runAnalyst,
        });

        // ── Persist ───────────────────────────────────────────
        let createdCount = 0;
        for (const n of result.notifications) {
          try {
            await prisma.asoNotification.upsert({
              where: { dedupKey: n.dedupKey },
              create: {
                tenantId: input.tenantId,
                appId: input.appId,
                date: new Date(date),
                dedupKey: n.dedupKey,
                severity: n.severity,
                title: n.title,
                message: n.message,
                payload: n.payload as object,
                trackedKeywordId: n.trackedKeywordId,
                competitorId: n.competitorId,
                agentInterpretation: n.agentInterpretation,
                agentProbableCause: n.agentProbableCause,
                agentNextAction: n.agentNextAction,
                agentConfidence: n.agentConfidence,
              },
              update: {
                agentInterpretation: n.agentInterpretation,
                agentProbableCause: n.agentProbableCause,
                agentNextAction: n.agentNextAction,
                agentConfidence: n.agentConfidence,
              },
            });
            createdCount += 1;
          } catch {
            /* swallow per-row failures so the rest can land */
          }
        }

        const alarmKinds = Array.from(new Set(result.events.map((e) => e.kind)));
        await prisma.asoDailyCheck.update({
          where: { id: running.id },
          data: {
            status: "COMPLETED",
            metricsSnapshot: snapToday
              ? (JSON.parse(JSON.stringify(snapToday)) as object)
              : ({} as object),
            keywordDeltas: JSON.parse(JSON.stringify(keywordDeltas)) as object,
            competitorMoves: JSON.parse(JSON.stringify(competitorDeltas)) as object,
            alarmsTriggered: alarmKinds,
            analystReport: result.analystReport
              ? (JSON.parse(JSON.stringify(result.analystReport)) as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
        });

        await recordAudit({
          action: "aso.dailyCheck.run",
          target: `app:${input.appId}`,
          outcome: "SUCCESS",
          appId: input.appId,
          diff: {
            date,
            severity: result.overallSeverity,
            notifications: createdCount,
            analystRan,
          },
        });

        return {
          checkId: running.id,
          date,
          overallSeverity: result.overallSeverity,
          counts: result.counts,
          notificationsCreated: createdCount,
          analystRan,
        };
      } catch (err) {
        await prisma.asoDailyCheck.update({
          where: { id: running.id },
          data: {
            status: "FAILED",
            analystReport: {
              error: err instanceof Error ? err.message : String(err),
            } as Prisma.InputJsonValue,
          },
        });
        throw err;
      }
    },
  );
}

function subtractDays(yyyyMmDd: string, days: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function avg(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v != null);
  if (real.length === 0) return null;
  return real.reduce((a, b) => a + b, 0) / real.length;
}

function buildAnalystMetricsLocal(
  date: string,
  today: { pvcrPct: unknown; impressions: number; downloads: number } | undefined,
  yesterday: { pvcrPct: unknown; impressions: number; downloads: number } | undefined,
  baseline: { pvcrPct: unknown; impressions: number; downloads: number }[],
): AnalystMetricSnapshot {
  return {
    date,
    downloadsToday: today?.downloads ?? null,
    downloadsYesterday: yesterday?.downloads ?? null,
    downloads7dAvg: avg(baseline.map((s) => s.downloads)),
    impressionsToday: today?.impressions ?? null,
    impressionsYesterday: yesterday?.impressions ?? null,
    cvrToday: today?.pvcrPct != null ? Number(today.pvcrPct) : null,
    cvrYesterday: yesterday?.pvcrPct != null ? Number(yesterday.pvcrPct) : null,
    cvr7dAvg: avg(baseline.map((s) => (s.pvcrPct != null ? Number(s.pvcrPct) : null))),
    ratingToday: null,
    ratingYesterday: null,
    newLowStarReviewsToday: 0,
  };
}

function pickKeywordHighlights(deltas: KeywordRankDelta[]): AnalystKeywordHighlight[] {
  return deltas
    .filter((d) => d.rankToday != null || d.rankYesterday != null)
    .map((d) => ({
      delta: Math.abs((d.rankYesterday ?? 100) - (d.rankToday ?? 100)),
      payload: d,
    }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20)
    .map(({ payload }) => ({
      trackedKeywordId: payload.trackedKeywordId,
      keyword: payload.keyword,
      territory: payload.territory,
      tags: payload.tags,
      rankToday: payload.rankToday,
      rankYesterday: payload.rankYesterday,
      bucketToday: payload.bucketToday,
    }));
}

function pickCompetitorHighlights(deltas: CompetitorRankDelta[]): AnalystCompetitorHighlight[] {
  return deltas
    .filter((d) => d.rankToday != null || d.rankYesterday != null)
    .slice(0, 10)
    .map((d) => ({
      competitorId: d.competitorId,
      competitorName: d.competitorName,
      keyword: d.keyword,
      rankToday: d.rankToday,
      rankYesterday: d.rankYesterday,
      ourRankToday: d.ourRankToday,
    }));
}

// ─────────────────────────────────────────────────────────────────────
// aso.daily-check.schedule — nightly fan-out
//
// Triggered by a repeatable BullMQ cron. Enqueues one
// `aso.daily-check` job per connected app. Uses prismaUnscoped because
// the scheduler has no tenant context (RLS would otherwise filter
// every app row to zero).
// ─────────────────────────────────────────────────────────────────────

export interface AsoDailyCheckScheduleInput {
  /** Which fan-out to run.
   *   • 'daily-check' (default) — alarm evaluation + notifications.
   *   • 'astro' — Astro Autopilot refresh.
   *   • 'analytics' — pull App Store Connect Analytics + Sales Reports
   *     for the previous 2 days (Apple's reports have a ~36h lag, so
   *     asking only for "yesterday" leaves us with empty rows).
   *   • 'competitor-sync' — refresh every monitored competitor's
   *     iTunes Lookup metadata + screenshots across each active
   *     locale's territory. Diffs against the prior snapshot and
   *     fires AsoNotification rows on any change. */
  mode?: "astro" | "daily-check" | "analytics" | "competitor-sync";
  tenantId?: string;
  date?: string;
}

export async function processAsoDailyCheckSchedule(
  input: AsoDailyCheckScheduleInput,
): Promise<{ apps: number; enqueued: number; date: string; mode: string }> {
  const { prismaUnscoped } = await import("@marquee/db");
  const { queues } = await import("@marquee/jobs");

  const mode = input.mode ?? "daily-check";
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  // Astro is iOS-only. Daily-check is too (the alarm engine has no
  // Google Play heuristics yet). Filter accordingly so we don't
  // enqueue useless work for Android apps.
  const apps = await prismaUnscoped.app.findMany({
    where: {
      isConnected: true,
      platform: "IOS",
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(mode === "astro" ? { trackedKeywords: { some: { status: "ACTIVE" } } } : {}),
    },
    select: { id: true, tenantId: true, appName: true },
  });

  let enqueued = 0;
  if (mode === "astro") {
    // Fan out Astro Autopilot. aso.astro.analyze worker is concurrency=1
    // so per-tenant rate limiter stays happy.
    for (const app of apps) {
      try {
        await queues["aso.astro.analyze"].add(
          `astro-nightly:${app.id}:${date}`,
          {
            tenantId: app.tenantId,
            userId: "00000000-0000-0000-0000-000000000000",
            appId: app.id,
            includeCompetitorMining: false,
            skipEmptyTerritories: true,
          },
          { jobId: `astro-nightly:${app.id}:${date}` },
        );
        enqueued += 1;
      } catch {
        /* duplicate jobId — already enqueued */
      }
    }
  } else if (mode === "analytics") {
    // Fan out App Store Connect Analytics + Sales Reports ingestion.
    // We deliberately pull a 2-day window ending yesterday so the 36h
    // Apple-publishing lag doesn't routinely empty the freshest day.
    // The processor will upsert per-date, so re-running the same window
    // tomorrow is idempotent + revises yesterday's numbers (Apple
    // sometimes restates them in the first 48h after the day closes).
    const lookback = computeAnalyticsLookback(date);
    for (const app of apps) {
      try {
        await queues["aso.analytics.sync"].add(
          `analytics-nightly:${app.id}:${date}`,
          {
            tenantId: app.tenantId,
            userId: "00000000-0000-0000-0000-000000000000",
            appId: app.id,
            fromDate: lookback.fromDate,
            toDate: lookback.toDate,
          },
          { jobId: `analytics-nightly:${app.id}:${date}` },
        );
        enqueued += 1;
      } catch {
        /* duplicate jobId — already enqueued */
      }
    }
  } else if (mode === "competitor-sync") {
    // Fan out competitor metadata syncs. Per-app job; the processor
    // itself handles per-territory pacing under Apple's unwritten ~20
    // req/min rate ceiling. Worker concurrency is 1 (set at boot) so
    // even with 30+ apps registered we stay well within Apple's bucket.
    for (const app of apps) {
      try {
        await queues["aso.competitor-sync"].add(
          `competitor-sync:${app.id}:${date}`,
          {
            tenantId: app.tenantId,
            appId: app.id,
            date,
            userId: null,
          },
          { jobId: `competitor-sync:${app.id}:${date}` },
        );
        enqueued += 1;
      } catch {
        /* duplicate jobId — already enqueued */
      }
    }
  } else {
    for (const app of apps) {
      try {
        await queues["aso.daily-check"].add(
          `daily-check:${app.id}:${date}`,
          {
            tenantId: app.tenantId,
            appId: app.id,
            date,
            withAnalyst: true,
            userId: null,
          },
          { jobId: `daily-check:${app.id}:${date}` },
        );
        enqueued += 1;
      } catch {
        /* duplicate jobId — already enqueued */
      }
    }
  }

  return { apps: apps.length, enqueued, date, mode };
}

/** Compute the analytics fetch window for the nightly fan-out. Pulls
 *  the 2 calendar days ending yesterday so Apple's ~36h publishing lag
 *  doesn't routinely leave the freshest day empty. */
function computeAnalyticsLookback(scheduleDate: string): {
  fromDate: string;
  toDate: string;
} {
  const anchor = new Date(`${scheduleDate}T00:00:00.000Z`);
  // toDate = scheduleDate - 1 day (yesterday). fromDate = scheduleDate - 2.
  const to = new Date(anchor);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - 2);
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────
// aso.competitor-sync processor
//
// For one app, refresh every monitored competitor's iTunes Lookup
// payload across every active locale's territory; diff vs. the most
// recent prior snapshot; write today's snapshot + AsoNotification rows
// for every change; update the denormalised "latest" mirrors on the
// Competitor row.
//
// Rate-limit discipline — Apple doesn't publish a Lookup limit but a
// 429 sweep around ~20 req/min has been observed when scripts go hard.
// We pace strictly inside the processor (not via BullMQ rate-limiter
// because the unit of rate-limiting is per-IP-per-minute, which the
// queue layer can't enforce across concurrent workers). Tuning:
//
//   • Sequential per (competitor × territory)
//   • 250 ms sleep between calls → max ~4 req/s, ~240 req/min worst case
//     (well above what one app will queue in practice; the BullMQ worker
//     is concurrency=1 so two apps' syncs run back-to-back, not parallel)
//   • Exponential backoff on lookup errors: 500 ms × 2^attempt up to 3
//   • Per-territory failure isolation — one storefront's 5xx doesn't
//     poison the rest of the run
//
// Idempotency — same UTC date re-runs are a no-op: the unique
// constraint on (competitorId, territory, date) plus `skipDuplicates`
// inside the snapshot write means the second run captures fresh data
// without dupes, and the notification upsert is keyed by `dedupKey` so
// the diff engine's events also dedup.
// ─────────────────────────────────────────────────────────────────────

export interface AsoCompetitorSyncInput {
  tenantId: string;
  userId?: string | null;
  appId: string;
  /** YYYY-MM-DD. Defaults to today UTC. */
  date?: string;
  /** Bypass the `monitor=true` filter — used by the per-card UI
   *  "Sync now" path so a paused competitor can still be force-
   *  refreshed without flipping the monitor flag. */
  includeUnmonitored?: boolean;
  /** Restrict the run to specific competitors. Used by "Sync now"
   *  so we don't refetch the whole roster when only one card was
   *  clicked. */
  competitorIds?: string[];
}

/** Wall-clock pause between iTunes Lookup calls. 250 ms keeps us at
 *  ~4 req/s — comfortably below Apple's empirical ~20 req/min ceiling
 *  while still draining a 30-territory app under 8 seconds. */
const LOOKUP_INTERVAL_MS = 250;
const LOOKUP_BACKOFF_BASE_MS = 500;
const LOOKUP_MAX_ATTEMPTS = 3;

export async function processAsoCompetitorSync(input: AsoCompetitorSyncInput): Promise<{
  appId: string;
  date: string;
  competitorsScanned: number;
  territoriesScanned: number;
  snapshotsWritten: number;
  notificationsCreated: number;
  errors: number;
}> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const todayDate = new Date(`${date}T00:00:00.000Z`);

  return tenantStorage.run(
    {
      tenantId: input.tenantId,
      userId: input.userId ?? "00000000-0000-0000-0000-000000000000",
      role: "OWNER",
      requestId: crypto.randomUUID(),
    },
    async () => {
      const app = await prisma.app.findFirst({
        where: { id: input.appId, tenantId: input.tenantId },
        select: { id: true, primaryLocale: true },
      });
      if (!app) throw new NotFoundError("App not found");

      // ── Resolve target territories ───────────────────────────────
      // Same logic as ingest: every active locale → territory, dedup
      // across multi-locale storefronts (en-US + es-US → US once).
      const localizations = await prisma.appLocalization.findMany({
        where: { appId: input.appId },
        select: { locale: true },
      });
      const territorySet = new Set<string>();
      territorySet.add(localeRegion(app.primaryLocale).toUpperCase());
      for (const l of localizations) {
        territorySet.add(localeRegion(l.locale).toUpperCase());
      }
      const territories = Array.from(territorySet);

      // ── Resolve competitors to sync ──────────────────────────────
      const competitors = await prisma.competitor.findMany({
        where: {
          appId: input.appId,
          ...(input.includeUnmonitored ? {} : { monitor: true }),
          ...(input.competitorIds && input.competitorIds.length > 0
            ? { id: { in: input.competitorIds } }
            : {}),
          // Need a storeAppId to call iTunes Lookup — skip silently
          // if the row was created without one (legacy CRUD path).
          storeAppId: { not: null },
        },
        select: { id: true, storeAppId: true, appName: true },
      });

      if (competitors.length === 0) {
        return {
          appId: input.appId,
          date,
          competitorsScanned: 0,
          territoriesScanned: 0,
          snapshotsWritten: 0,
          notificationsCreated: 0,
          errors: 0,
        };
      }

      let snapshotsWritten = 0;
      let notificationsCreated = 0;
      let errors = 0;
      let territoriesScanned = 0;

      for (const c of competitors) {
        if (!c.storeAppId) continue;
        // Capture mirrors from the home/primary-locale snapshot we get
        // last (or the first successful one) to update Competitor
        // denormalised fields.
        let mirrorSource: ItunesLookupResult | null = null;

        for (const territory of territories) {
          territoriesScanned++;
          let attempt = 0;
          let lookup: ItunesLookupResult | null = null;
          // Retry with exponential backoff on transient errors. A validation
          // error (invalid country) `break`s out immediately — no retry.
          while (attempt < LOOKUP_MAX_ATTEMPTS) {
            try {
              lookup = await iTunesLookup({
                storeAppId: c.storeAppId,
                country: territory.toLowerCase(),
              });
              break;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // Validation-time errors (invalid country code etc) are
              // fatal — no point retrying.
              if (msg.includes("invalid country") || msg.includes("must be numeric")) {
                break;
              }
              attempt++;
              if (attempt >= LOOKUP_MAX_ATTEMPTS) break;
              await sleep(LOOKUP_BACKOFF_BASE_MS * 2 ** attempt);
            }
          }
          // Pace BEFORE counting the result, so the next iteration's
          // call lands in a fresh second.
          await sleep(LOOKUP_INTERVAL_MS);

          if (!lookup) {
            // Apple has no record for this app in this storefront —
            // common (apps pulled from country X but live elsewhere).
            // Not an error, just no snapshot to write today.
            continue;
          }

          // Remember the first non-null lookup as the mirror source.
          // The home territory is whatever appears first in the set —
          // for our use case, the primary locale's territory drives
          // the UI display, so prefer that one explicitly.
          if (
            mirrorSource === null ||
            territory === localeRegion(app.primaryLocale).toUpperCase()
          ) {
            mirrorSource = lookup;
          }

          // ── Fetch latest prior snapshot for this territory ──────
          const prev = await prisma.competitorSnapshot.findFirst({
            where: { competitorId: c.id, territory },
            orderBy: { date: "desc" },
          });

          // ── Upsert today's snapshot ─────────────────────────────
          const snapshotData = {
            tenantId: input.tenantId,
            competitorId: c.id,
            territory,
            date: todayDate,
            name: lookup.name || null,
            subtitle: lookup.subtitle,
            description: lookup.description,
            releaseNotes: lookup.releaseNotes,
            version: lookup.version,
            currentVersionReleaseDate: lookup.currentVersionReleaseDate,
            averageUserRating: lookup.averageUserRating,
            userRatingCount: lookup.userRatingCount,
            averageUserRatingForCurrentVersion: lookup.averageUserRatingForCurrentVersion,
            userRatingCountForCurrentVersion: lookup.userRatingCountForCurrentVersion,
            iconUrl: lookup.iconUrl,
            iphoneScreenshotUrls: lookup.iphoneScreenshotUrls,
            ipadScreenshotUrls: lookup.ipadScreenshotUrls,
            sellerName: lookup.sellerName,
            primaryGenre: lookup.primaryGenre,
            primaryGenreId: lookup.primaryGenreId,
            genres: lookup.genres,
            contentAdvisoryRating: lookup.contentAdvisoryRating,
            minimumOsVersion: lookup.minimumOsVersion,
            languageCodes: lookup.languageCodes,
            price: lookup.price,
            currency: lookup.currency,
            formattedPrice: lookup.formattedPrice,
            trackUrl: lookup.trackUrl,
            fetchedAt: new Date(),
          };
          try {
            await prisma.competitorSnapshot.upsert({
              where: {
                competitorId_territory_date: {
                  competitorId: c.id,
                  territory,
                  date: todayDate,
                },
              },
              create: snapshotData,
              update: snapshotData,
            });
            snapshotsWritten++;
          } catch (err) {
            errors++;
            console.error(
              `[competitor-sync] snapshot upsert failed for ${c.appName} (${territory}):`,
              err instanceof Error ? err.message : err,
            );
            continue;
          }

          // ── Diff + emit notifications ───────────────────────────
          // Only diff if we have a real prior snapshot (not today's,
          // which would diff against itself on a same-day re-run).
          if (prev && prev.date.toISOString().slice(0, 10) !== date) {
            const events = diffCompetitorSnapshots(
              snapshotInputFromRow(prev),
              snapshotInputFromRow(snapshotData),
            );
            for (const evt of events) {
              try {
                const dedupKey = `competitor-change:${c.id}:${territory}:${date}:${evt.kind}`;
                await prisma.asoNotification.upsert({
                  where: { dedupKey },
                  create: {
                    tenantId: input.tenantId,
                    appId: input.appId,
                    competitorId: c.id,
                    date: todayDate,
                    dedupKey,
                    severity: evt.severity,
                    title: `${c.appName} (${territory}): ${evt.headline}`,
                    message: evt.detail,
                    payload: {
                      kind: evt.kind,
                      territory,
                      competitorName: c.appName,
                      ...evt.payload,
                    } as object,
                  },
                  update: {
                    // Allow detail / severity revision when the diff
                    // engine evolves between runs — but the dedupKey
                    // keeps us from double-counting.
                    severity: evt.severity,
                    title: `${c.appName} (${territory}): ${evt.headline}`,
                    message: evt.detail,
                  },
                });
                notificationsCreated++;
              } catch (err) {
                errors++;
                console.error(
                  `[competitor-sync] notification upsert failed:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }
          }
        }

        // ── Update Competitor's denormalised "latest" mirrors ──────
        if (mirrorSource) {
          await prisma.competitor.update({
            where: { id: c.id },
            data: {
              appName: mirrorSource.name || c.appName,
              iconUrl: mirrorSource.iconUrl,
              trackUrl: mirrorSource.trackUrl,
              sellerName: mirrorSource.sellerName,
              primaryGenre: mirrorSource.primaryGenre,
              latestVersion: mirrorSource.version,
              latestRating: mirrorSource.averageUserRating,
              latestRatingCount: mirrorSource.userRatingCount,
              lastSyncedAt: new Date(),
            },
          });
        }
      }

      await recordAudit({
        action: "aso.competitor.sync",
        target: `app:${input.appId}`,
        outcome: errors > 0 ? "PARTIAL" : "SUCCESS",
        appId: input.appId,
        diff: {
          date,
          competitorsScanned: competitors.length,
          territoriesScanned,
          snapshotsWritten,
          notificationsCreated,
          errors,
        },
      });

      return {
        appId: input.appId,
        date,
        competitorsScanned: competitors.length,
        territoriesScanned,
        snapshotsWritten,
        notificationsCreated,
        errors,
      };
    },
  );
}

/** Pluck the diff-input fields from either a Prisma row or the
 *  upsert payload. Keeps the diff engine pure (no Prisma types). */
function snapshotInputFromRow(row: {
  name: string | null;
  subtitle: string | null;
  description: string | null;
  releaseNotes: string | null;
  version: string | null;
  averageUserRating: number | null;
  userRatingCount: number | null;
  iphoneScreenshotUrls: string[];
  ipadScreenshotUrls: string[];
  sellerName: string | null;
  primaryGenre: string | null;
  genres: string[];
  contentAdvisoryRating: string | null;
  minimumOsVersion: string | null;
  languageCodes: string[];
  price: number | null;
  currency: string | null;
}): CompetitorSnapshotInput {
  return {
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    releaseNotes: row.releaseNotes,
    version: row.version,
    averageUserRating: row.averageUserRating,
    userRatingCount: row.userRatingCount,
    iphoneScreenshotUrls: row.iphoneScreenshotUrls,
    ipadScreenshotUrls: row.ipadScreenshotUrls,
    sellerName: row.sellerName,
    primaryGenre: row.primaryGenre,
    genres: row.genres,
    contentAdvisoryRating: row.contentAdvisoryRating,
    minimumOsVersion: row.minimumOsVersion,
    languageCodes: row.languageCodes,
    price: row.price,
    currency: row.currency,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Side-effect-free reference so unused-import warnings stay silent
// when callers only consume the change-event type (e.g. in API routes
// returning notification payloads to the UI).
export type { CompetitorChangeEvent };
