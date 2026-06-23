/**
 * POST /api/v1/apps/[id]/aso/competitors/ingest
 *
 * "Paste an App Store URL → a fully tracked competitor" flow.
 *
 * Body shape:
 *   { url: "https://apps.apple.com/tr/app/magic-sort/id6499209744" }
 *
 * What happens, in order:
 *   1. Parse the URL → { storeAppId, country }.
 *   2. Look up the listing in the country the operator pasted (the
 *      "home" market) — this establishes the canonical bundleId, name,
 *      icon, and developer.
 *   3. Resolve the set of territories to snapshot: every active locale
 *      on the operator's app maps to a 2-letter ISO country code via
 *      `localeRegion`. Duplicates collapse (en-US + es-US → US once).
 *      The home country is always included.
 *   4. Create the `Competitor` row, denormalising name + icon + rating
 *      + version from the home snapshot for fast list rendering later.
 *   5. Fan out: for each territory, call iTunes Lookup with a 200ms
 *      jitter, write a `CompetitorSnapshot`. Misses (Apple returns no
 *      result for that storefront — common when an app isn't shipped
 *      in every country) are skipped silently; we keep going.
 *   6. Return the hydrated competitor + a summary of which territories
 *      produced a snapshot vs. which were missing.
 *
 * Idempotency: if a `Competitor` already exists for (appId, bundleId)
 * we return it as-is (HTTP 200, not 201). The daily sync job handles
 * the periodic refresh — no need to re-fan-out here.
 *
 * No external auth — iTunes Lookup is a public endpoint. The only
 * cost is sequential HTTP calls, capped at the app's locale count.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import {
  NotFoundError,
  ValidationError,
  iTunesLookup,
  parseAppStoreUrl,
  type ItunesLookupResult,
} from "@marquee/core";
import { localeRegion } from "@marquee/core/locale";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const IngestBody = z.object({
  url: z.string().trim().min(1).max(500),
  /** Optional override — when the operator already knows the bucket
   *  they want for this competitor. Defaults to SECONDARY otherwise. */
  bucket: z.enum(["PRIMARY", "SECONDARY", "WATCH"]).optional(),
  notes: z.string().trim().max(500).optional(),
});

export const dynamic = "force-dynamic";

/** Slim shape the UI needs back. Includes the just-written snapshot
 *  set so the operator immediately sees what we captured per territory. */
interface IngestResponse {
  ok: true;
  competitor: {
    id: string;
    appName: string;
    bundleId: string | null;
    storeAppId: string | null;
    iconUrl: string | null;
    trackUrl: string | null;
    sellerName: string | null;
    primaryGenre: string | null;
    latestVersion: string | null;
    latestRating: number | null;
    latestRatingCount: number | null;
    bucket: string | null;
    monitor: boolean;
  };
  /** Territories we snapshotted on first sync. */
  capturedTerritories: string[];
  /** Territories where Apple returned no result (app not shipped). */
  missingTerritories: string[];
  /** True when the operator pasted a URL for a competitor we already
   *  track — the response is the existing row, no new snapshots
   *  written here (the daily sync handles refresh). */
  alreadyTracked: boolean;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId } = await context.params;
  const body = IngestBody.parse(await req.json());

  const parsed = parseAppStoreUrl(body.url);
  if (!parsed) {
    throw new ValidationError(
      "Couldn't parse that as an App Store URL. Expected something like https://apps.apple.com/us/app/foo/id1234567890",
    );
  }

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id: appId },
      select: { id: true, primaryLocale: true },
    });
    if (!app) throw new NotFoundError("App not found");

    // ── 1. Home-territory lookup ────────────────────────────────────
    // We need the bundleId before we can dedup against existing
    // competitors. The home territory (the one in the pasted URL) is
    // the canonical source.
    const home = await iTunesLookup({
      storeAppId: parsed.storeAppId,
      country: parsed.country,
    });
    if (!home) {
      throw new ValidationError(
        `Apple has no record of App Store ID ${parsed.storeAppId} in the ${parsed.country.toUpperCase()} storefront. Double-check the URL.`,
      );
    }

    // ── 2. Dedup ───────────────────────────────────────────────────
    // If we already track this competitor on this app, return early.
    // The daily sync job will keep it fresh; ingest is for adding.
    const existing = home.bundleId
      ? await prisma.competitor.findUnique({
          where: { appId_bundleId: { appId, bundleId: home.bundleId } },
          select: { id: true, appName: true, bundleId: true, storeAppId: true, iconUrl: true, trackUrl: true, sellerName: true, primaryGenre: true, latestVersion: true, latestRating: true, latestRatingCount: true, bucket: true, monitor: true },
        })
      : null;
    if (existing) {
      const response: IngestResponse = {
        ok: true,
        competitor: existing,
        capturedTerritories: [],
        missingTerritories: [],
        alreadyTracked: true,
      };
      return NextResponse.json(response);
    }

    // ── 3. Resolve target territories ──────────────────────────────
    // Snapshot every territory the operator's app actually serves.
    // localeRegion maps locale codes ("en-US") → ISO country ("US").
    // Set semantics dedup multi-locale storefronts (es-US + en-US → US).
    const localizations = await prisma.appLocalization.findMany({
      where: { appId },
      select: { locale: true },
    });
    const territorySet = new Set<string>();
    territorySet.add(parsed.country.toUpperCase());
    territorySet.add(localeRegion(app.primaryLocale).toUpperCase());
    for (const l of localizations) {
      territorySet.add(localeRegion(l.locale).toUpperCase());
    }
    const territories = Array.from(territorySet);

    // ── 4. Fan out lookups ─────────────────────────────────────────
    // Sequential with a small jitter — Apple doesn't publish a rate
    // limit, but staying friendly avoids spurious 429s under load.
    const lookups = new Map<string, ItunesLookupResult>();
    const missing: string[] = [];
    // We already have the home-country result — seed the map.
    lookups.set(parsed.country.toUpperCase(), home);

    for (const t of territories) {
      if (lookups.has(t)) continue; // skip the home one we just did
      try {
        const r = await iTunesLookup({
          storeAppId: parsed.storeAppId,
          country: t.toLowerCase(),
        });
        if (r) lookups.set(t, r);
        else missing.push(t);
      } catch (err) {
        // A single territory failure shouldn't poison the ingest.
        // We log to console; the daily sync will retry tomorrow.
        console.warn(
          `[competitor.ingest] iTunes lookup failed for ${parsed.storeAppId} in ${t}:`,
          err instanceof Error ? err.message : err,
        );
        missing.push(t);
      }
      // 150ms jitter — empirically keeps Apple happy under burst.
      await new Promise((res) => setTimeout(res, 150));
    }

    if (lookups.size === 0) {
      throw new ValidationError(
        "Couldn't fetch this competitor in any of the territories your app serves.",
      );
    }

    // ── 5. Write Competitor + initial snapshots in a transaction ───
    const todayDate = new Date();
    todayDate.setUTCHours(0, 0, 0, 0);

    const created = await prisma.$transaction(async (tx) => {
      const competitor = await tx.competitor.create({
        data: {
          tenantId: ctx.tenant!.id,
          appId,
          // Denormalised mirrors from the home lookup — drive the list
          // view without joining the latest snapshot for every card.
          appName: home.name,
          bundleId: home.bundleId || null,
          storeAppId: home.storeAppId || null,
          iconUrl: home.iconUrl,
          trackUrl: home.trackUrl,
          sellerName: home.sellerName,
          primaryGenre: home.primaryGenre,
          ingestCountry: parsed.country.toUpperCase(),
          latestVersion: home.version,
          latestRating: home.averageUserRating,
          latestRatingCount: home.userRatingCount,
          lastSyncedAt: new Date(),
          bucket: body.bucket ?? "SECONDARY",
          monitor: true,
          notes: body.notes ?? null,
          createdById: ctx.user.id,
        },
      });

      // Initial snapshots — one per territory we successfully fetched.
      // No diff to compute on the very first capture; the daily sync
      // will diff against these from tomorrow onward.
      if (lookups.size > 0) {
        await tx.competitorSnapshot.createMany({
          data: Array.from(lookups.entries()).map(([territory, r]) => ({
            tenantId: ctx.tenant!.id,
            competitorId: competitor.id,
            territory,
            date: todayDate,
            name: r.name || null,
            subtitle: r.subtitle,
            description: r.description,
            releaseNotes: r.releaseNotes,
            version: r.version,
            currentVersionReleaseDate: r.currentVersionReleaseDate,
            averageUserRating: r.averageUserRating,
            userRatingCount: r.userRatingCount,
            averageUserRatingForCurrentVersion: r.averageUserRatingForCurrentVersion,
            userRatingCountForCurrentVersion: r.userRatingCountForCurrentVersion,
            iconUrl: r.iconUrl,
            iphoneScreenshotUrls: r.iphoneScreenshotUrls,
            ipadScreenshotUrls: r.ipadScreenshotUrls,
            sellerName: r.sellerName,
            primaryGenre: r.primaryGenre,
            primaryGenreId: r.primaryGenreId,
            genres: r.genres,
            contentAdvisoryRating: r.contentAdvisoryRating,
            minimumOsVersion: r.minimumOsVersion,
            languageCodes: r.languageCodes,
            price: r.price,
            currency: r.currency,
            formattedPrice: r.formattedPrice,
            trackUrl: r.trackUrl,
          })),
          skipDuplicates: true,
        });
      }

      return competitor;
    });

    await recordAudit({
      action: "aso.competitor.ingest",
      target: `competitor:${created.id}`,
      outcome: "SUCCESS",
      appId,
      diff: {
        url: body.url,
        storeAppId: created.storeAppId,
        bundleId: created.bundleId,
        appName: created.appName,
        capturedTerritories: Array.from(lookups.keys()),
        missingTerritories: missing,
      },
    });

    const response: IngestResponse = {
      ok: true,
      competitor: {
        id: created.id,
        appName: created.appName,
        bundleId: created.bundleId,
        storeAppId: created.storeAppId,
        iconUrl: created.iconUrl,
        trackUrl: created.trackUrl,
        sellerName: created.sellerName,
        primaryGenre: created.primaryGenre,
        latestVersion: created.latestVersion,
        latestRating: created.latestRating,
        latestRatingCount: created.latestRatingCount,
        bucket: created.bucket,
        monitor: created.monitor,
      },
      capturedTerritories: Array.from(lookups.keys()),
      missingTerritories: missing,
      alreadyTracked: false,
    };
    return NextResponse.json(response, { status: 201 });
  });
});
