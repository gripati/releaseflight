/**
 * App Store Connect Analytics Reports adapter — full client.
 *
 * Apple's Analytics Reports API is a 5-step dance:
 *
 *   1. POST /v1/analyticsReportRequests           — open an ONGOING request
 *   2. GET  /v1/analyticsReportRequests/{id}/reports          — list report names
 *   3. GET  /v1/analyticsReports/{id}/instances?granularity=DAILY
 *   4. GET  /v1/analyticsReportInstances/{id}/segments        — presigned URLs
 *   5. GET  segment.attributes.url                            — gzipped TSV
 *
 * Apple delivers each day's report ~36 h late. The worker should pull
 * yesterday-1 every morning. Reports that require sufficient usage (the
 * "Detailed" tier) may not exist for small apps — `findReport` returns
 * null and callers must fall back.
 */
import { gunzipSync } from "node:zlib";
import type { AppleClient } from "../apple/AppleClient";

export interface DailyAnalyticsRow {
  date: string; // YYYY-MM-DD UTC
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
}

export interface SourceFunnelRow {
  date: string;
  source: "SEARCH" | "BROWSE" | "APP_REFERRER" | "WEB_REFERRER" | "INSTITUTIONAL" | "UNAVAILABLE";
  territory: string; // ISO 3166-1 alpha-2 or "ALL"
  impressions: number;
  pageViews: number;
  downloads: number;
}

/** Per-report ingestion stats from one `getDailyRollupWithDiagnostics`
 *  call. Used to tell the operator at a glance whether Apple produced
 *  data for each report, vs which one came back empty. */
export interface PerReportDiagnostics {
  engagement: { segments: number; rows: number; applied: number };
  downloads: { segments: number; rows: number; applied: number };
  sessions: { segments: number; rows: number; applied: number };
  crashes: { segments: number; rows: number; applied: number };
}

/** Per-segment parser stats — how many TSV rows existed vs how many
 *  contributed non-zero data to the rollup. `applied < rows` indicates
 *  Apple emitted zero-valued rows (privacy threshold) or the parser
 *  failed to find the expected columns (header drift). */
interface ParserStats {
  rows: number;
  applied: number;
}

interface ReportRequestData {
  id: string;
  attributes: { accessType: string; stoppedDueToInactivity?: boolean };
}

interface ReportData {
  id: string;
  attributes: {
    name: string;
    category: string;
  };
}

interface InstanceData {
  id: string;
  attributes: {
    granularity: "DAILY" | "WEEKLY" | "MONTHLY";
    processingDate: string;
  };
}

interface SegmentData {
  id: string;
  attributes: {
    /** Presigned download URL — short-lived. */
    url: string;
    checksum?: string;
    sizeInBytes?: number;
  };
}

/**
 * Apple Analytics Reports — confirmed names (verified live against the
 * App Store Connect API for an active publisher account on 2026-05-18).
 *
 * Categories the publisher is auto-opted into:
 *
 *   • APP_STORE_ENGAGEMENT
 *       - "App Store Discovery and Engagement Standard"  ← impressions,
 *         product page views, downloads, sources, territories
 *       - "App Store Discovery and Engagement Detailed"  ← adds more
 *         breakdown dimensions, gated by usage threshold
 *
 *   • COMMERCE
 *       - "App Downloads Standard"  ← total downloads + first-time +
 *         re-downloads split
 *       - "App Downloads Detailed"  ← per-version breakdown
 *
 *   • APP_USAGE
 *       - "App Sessions Standard"  ← sessions + active devices
 *       - "App Crashes"            ← daily crash counts (NOT "Standard")
 *
 * The previous version of this file used the WRONG names (e.g.
 * "App Store Engagement Standard" without the "Discovery and" prefix)
 * which made `findReport` silently return null and `getDailyRollup`
 * silently produce zero rows for every day.
 */
export const REPORT_NAMES = {
  /** Engagement + acquisition source funnel — single report. */
  DISCOVERY_AND_ENGAGEMENT_STANDARD: "App Store Discovery and Engagement Standard",
  /** Higher-dimension variant (territory × source × page type). */
  DISCOVERY_AND_ENGAGEMENT_DETAILED: "App Store Discovery and Engagement Detailed",
  /** First-time vs re-downloads split. */
  APP_DOWNLOADS_STANDARD: "App Downloads Standard",
  APP_DOWNLOADS_DETAILED: "App Downloads Detailed",
  /** Sessions + active devices. */
  APP_SESSIONS_STANDARD: "App Sessions Standard",
  /** Daily crash counts. */
  APP_CRASHES: "App Crashes",
} as const;

export class AnalyticsReports {
  /**
   * Caches that live for the lifetime of one sync run. Without them a
   * 90-day backfill would call `findReport` (paginated GET against
   * Apple) 90 × 4 reports × 2 request types = 720 times just to
   * resolve report IDs — Apple rate-limits those at 60 calls/min, so
   * the sync would 429 long before fetching segments.
   *
   * Key for requestIdsCache:  `${storeAppId}`
   * Key for reportIdCache:    `${requestId}::${reportName}`
   */
  private requestIdsCache: string[] | null = null;
  private readonly reportIdCache = new Map<string, string | null>();

  constructor(private readonly client: AppleClient) {}

  /**
   * Ensure BOTH report-request types exist for this app:
   *
   *   • ONGOING            — Apple produces a fresh daily report each
   *                          day. Has 24-72 h ramp-up after the first
   *                          POST before any daily instance is created.
   *   • ONE_TIME_SNAPSHOT  — Apple produces a one-shot historical
   *                          snapshot covering the past 365 days. Much
   *                          shorter latency (minutes to a few hours).
   *
   * Having both means the worker can pull historical data NOW while
   * the ONGOING request warms up. From the next day onward the ONGOING
   * stream serves the fresh data.
   *
   * Returns BOTH request IDs so callers can search reports across them.
   */
  async ensureReportRequest(storeAppId: string): Promise<string[]> {
    if (this.requestIdsCache) return this.requestIdsCache;

    const existing = await this.client.request<{ data: ReportRequestData[] }>({
      method: "GET",
      path: `/apps/${encodeURIComponent(storeAppId)}/analyticsReportRequests`,
      query: { limit: 50 },
    });
    const have = new Map<string, string>();
    for (const r of existing.data) {
      have.set(r.attributes.accessType, r.id);
    }

    const ids: string[] = [];
    for (const accessType of ["ONGOING", "ONE_TIME_SNAPSHOT"] as const) {
      let id = have.get(accessType);
      if (!id) {
        const created = await this.client.request<{ data: ReportRequestData }>({
          method: "POST",
          path: "/analyticsReportRequests",
          body: {
            data: {
              type: "analyticsReportRequests",
              attributes: { accessType },
              relationships: { app: { data: { type: "apps", id: storeAppId } } },
            },
          },
        });
        id = created.data.id;
      }
      ids.push(id);
    }
    this.requestIdsCache = ids;
    return ids;
  }

  /** Find the named report under a request. Returns null when Apple hasn't
   *  unlocked it yet (insufficient usage for Detailed tiers).
   *  Results are cached for the lifetime of this adapter instance to
   *  avoid spamming Apple's paginated GET on backfill loops. */
  async findReport(requestId: string, name: string): Promise<string | null> {
    const cacheKey = `${requestId}::${name}`;
    if (this.reportIdCache.has(cacheKey)) return this.reportIdCache.get(cacheKey) ?? null;

    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await this.client.request<{ data: ReportData[]; links?: { next?: string } }>({
        method: "GET",
        path: `/analyticsReportRequests/${encodeURIComponent(requestId)}/reports`,
        query: cursor ? { cursor, limit: 200 } : { limit: 200 },
      });
      // Cache EVERY name we see so subsequent lookups for OTHER report
      // names skip the API altogether.
      for (const r of res.data) {
        this.reportIdCache.set(`${requestId}::${r.attributes.name}`, r.id);
      }
      const match = res.data.find((r) => r.attributes.name === name);
      if (match) return match.id;
      if (!res.links?.next) {
        this.reportIdCache.set(cacheKey, null);
        return null;
      }
      const nextUrl = new URL(res.links.next);
      const c = nextUrl.searchParams.get("cursor");
      if (!c) {
        this.reportIdCache.set(cacheKey, null);
        return null;
      }
      cursor = c;
    }
    this.reportIdCache.set(cacheKey, null);
    return null;
  }

  /** Find the DAILY instance for a specific processing date. */
  async findDailyInstance(reportId: string, processingDate: string): Promise<string | null> {
    const res = await this.client.request<{ data: InstanceData[] }>({
      method: "GET",
      path: `/analyticsReports/${encodeURIComponent(reportId)}/instances`,
      query: {
        "filter[granularity]": "DAILY",
        "filter[processingDate]": processingDate,
        limit: 1,
      },
    });
    return res.data[0]?.id ?? null;
  }

  /** List segment download URLs for an instance. */
  async listSegments(instanceId: string): Promise<SegmentData[]> {
    const res = await this.client.request<{ data: SegmentData[] }>({
      method: "GET",
      path: `/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments`,
      query: { limit: 100 },
    });
    return res.data;
  }

  /** Download one segment + gunzip + return the TSV body as a string. */
  async downloadSegment(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Apple segment download failed: HTTP ${res.status.toString()}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Apple ships these as .csv.gz (tab-separated despite the .csv extension)
    const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const body = isGzip ? gunzipSync(buf) : buf;
    return body.toString("utf8");
  }

  /**
   * High-level: fetch and parse the daily app-level rollup for one date.
   * Combines four reports in parallel and merges the columns we care
   * about:
   *
   *   • Discovery and Engagement (Standard) — impressions, pageViews,
   *     downloads (sum), source × territory rows
   *   • App Downloads (Standard) — firstTime / re-download split
   *   • App Sessions (Standard) — sessions + active devices
   *   • App Crashes — crash counts
   *
   * Returns null only when NONE of the four reports has any data for
   * the date. Apple's typical SLA is ~36h after the day closes, with a
   * 24-72h ramp-up after a new ONGOING report request is opened.
   */
  async getDailyRollup(storeAppId: string, date: string): Promise<DailyAnalyticsRow | null> {
    const out = await this.getDailyRollupWithDiagnostics(storeAppId, date);
    return out.rollup;
  }

  /**
   * Same as {@link getDailyRollup} but also returns per-report
   * diagnostics describing exactly which Apple report produced data
   * vs which one came back empty. Useful for the worker to surface a
   * "your app is in Apple's 24-72 h ramp-up window" diagnostic when
   * impressions/page-view metrics don't show up: those columns ONLY
   * come from the App Store Discovery and Engagement report, so if
   * its segment count is 0 that explains the empty UI cells.
   *
   * Each per-report block records:
   *   • `segments` — how many segment files Apple returned (0 = report
   *     has no daily instance yet for this date)
   *   • `rows`     — total raw rows across all those segments
   *   • `applied`  — rows the parser actually consumed (non-zero values)
   *
   * The `applied < rows` case indicates Apple emitted rows but they
   * were zeroed (privacy threshold) or the parser couldn't find the
   * expected columns (header drift).
   */
  async getDailyRollupWithDiagnostics(
    storeAppId: string,
    date: string,
  ): Promise<{
    rollup: DailyAnalyticsRow | null;
    diagnostics: PerReportDiagnostics;
  }> {
    const requestIds = await this.ensureReportRequest(storeAppId);

    const rollup: DailyAnalyticsRow = {
      date,
      impressions: 0,
      pageViews: 0,
      downloads: 0,
      firstTimeDownloads: 0,
      redownloads: 0,
      sessions: 0,
      activeDevices1d: 0,
      activeDevices7d: 0,
      activeDevices30d: 0,
      crashes: 0,
    };

    const [engagementSegs, downloadsSegs, sessionsSegs, crashesSegs] = await Promise.all([
      this.segmentsAcrossRequests(requestIds, REPORT_NAMES.DISCOVERY_AND_ENGAGEMENT_STANDARD, date),
      this.segmentsAcrossRequests(requestIds, REPORT_NAMES.APP_DOWNLOADS_STANDARD, date),
      this.segmentsAcrossRequests(requestIds, REPORT_NAMES.APP_SESSIONS_STANDARD, date),
      this.segmentsAcrossRequests(requestIds, REPORT_NAMES.APP_CRASHES, date),
    ]);

    const diag: PerReportDiagnostics = {
      engagement: { segments: engagementSegs.length, rows: 0, applied: 0 },
      downloads: { segments: downloadsSegs.length, rows: 0, applied: 0 },
      sessions: { segments: sessionsSegs.length, rows: 0, applied: 0 },
      crashes: { segments: crashesSegs.length, rows: 0, applied: 0 },
    };

    let anyData = false;

    for (const seg of engagementSegs) {
      const tsv = await this.downloadSegment(seg.attributes.url);
      const stats = sumEngagementRows(tsv, rollup);
      diag.engagement.rows += stats.rows;
      diag.engagement.applied += stats.applied;
      if (stats.applied > 0) anyData = true;
    }
    for (const seg of downloadsSegs) {
      const tsv = await this.downloadSegment(seg.attributes.url);
      const stats = sumDownloadsRows(tsv, rollup);
      diag.downloads.rows += stats.rows;
      diag.downloads.applied += stats.applied;
      if (stats.applied > 0) anyData = true;
    }
    for (const seg of sessionsSegs) {
      const tsv = await this.downloadSegment(seg.attributes.url);
      const stats = sumSessionsRows(tsv, rollup);
      diag.sessions.rows += stats.rows;
      diag.sessions.applied += stats.applied;
      if (stats.applied > 0) anyData = true;
    }
    for (const seg of crashesSegs) {
      const tsv = await this.downloadSegment(seg.attributes.url);
      const stats = sumCrashesRows(tsv, rollup);
      diag.crashes.rows += stats.rows;
      diag.crashes.applied += stats.applied;
      if (stats.applied > 0) anyData = true;
    }

    // Last-resort fallback: if downloads is 0 but firstTime > 0 (or
    // vice-versa), Apple sometimes reports them in different schemas.
    if (rollup.downloads === 0 && (rollup.firstTimeDownloads > 0 || rollup.redownloads > 0)) {
      rollup.downloads = rollup.firstTimeDownloads + rollup.redownloads;
    }
    if (rollup.firstTimeDownloads === 0 && rollup.redownloads === 0 && rollup.downloads > 0) {
      rollup.firstTimeDownloads = rollup.downloads;
    }

    return { rollup: anyData ? rollup : null, diagnostics: diag };
  }

  /**
   * Per-source × per-territory funnel for one date. Uses the Detailed
   * variant when available (richer breakdown) and falls back to the
   * Standard variant.
   */
  async getSourceFunnel(storeAppId: string, date: string): Promise<SourceFunnelRow[]> {
    const requestIds = await this.ensureReportRequest(storeAppId);
    let segments = await this.segmentsAcrossRequests(
      requestIds,
      REPORT_NAMES.DISCOVERY_AND_ENGAGEMENT_DETAILED,
      date,
    );
    if (segments.length === 0) {
      segments = await this.segmentsAcrossRequests(
        requestIds,
        REPORT_NAMES.DISCOVERY_AND_ENGAGEMENT_STANDARD,
        date,
      );
    }
    if (segments.length === 0) return [];

    const rows: SourceFunnelRow[] = [];
    for (const seg of segments) {
      const tsv = await this.downloadSegment(seg.attributes.url);
      rows.push(...parseDiscoveryRows(tsv, date));
    }
    return rows;
  }

  /**
   * Quick check the worker can run BEFORE pulling individual reports
   * to tell the user whether Apple has actually produced data yet.
   * Returns the per-report counts of daily instances available — summed
   * across both the ONGOING and ONE_TIME_SNAPSHOT request types.
   */
  async getInstanceAvailability(storeAppId: string): Promise<Record<string, number>> {
    const requestIds = await this.ensureReportRequest(storeAppId);
    const names = Object.values(REPORT_NAMES);
    const counts: Record<string, number> = {};
    for (const name of names) {
      let total = 0;
      for (const rid of requestIds) {
        const reportId = await this.findReport(rid, name);
        if (!reportId) continue;
        const res = await this.client.request<{ data: InstanceData[] }>({
          method: "GET",
          path: `/analyticsReports/${encodeURIComponent(reportId)}/instances`,
          query: { "filter[granularity]": "DAILY", limit: 200 },
        });
        total += res.data.length;
      }
      counts[name] = total;
    }
    return counts;
  }

  /** Shared helper: report → instance → segments for one date. */
  private async segmentsFor(
    requestId: string,
    reportName: string,
    date: string,
  ): Promise<SegmentData[]> {
    const reportId = await this.findReport(requestId, reportName);
    if (!reportId) return [];
    const instanceId = await this.findDailyInstance(reportId, date);
    if (!instanceId) return [];
    return this.listSegments(instanceId);
  }

  /**
   * Same as `segmentsFor` but searches across multiple request IDs and
   * returns the first non-empty result. ONE_TIME_SNAPSHOT is usually
   * checked first so we get the historical-immediate data; ONGOING
   * supplies forward-going daily fills.
   */
  private async segmentsAcrossRequests(
    requestIds: string[],
    reportName: string,
    date: string,
  ): Promise<SegmentData[]> {
    for (const rid of requestIds) {
      const segs = await this.segmentsFor(rid, reportName, date);
      if (segs.length > 0) return segs;
    }
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────────────────────────────

interface ParsedTsv {
  headers: string[];
  rows: string[][];
}

/** Minimal TSV parser — Apple's reports are tab-separated, no quoting. */
export function parseTsv(text: string): ParsedTsv {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0]!.split("\t").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split("\t").map((c) => c.trim()));
  return { headers, rows };
}

function findColumn(headers: string[], candidates: string[]): number {
  for (const name of candidates) {
    const idx = headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function toNum(v: string | undefined): number {
  if (!v) return 0;
  // Apple sometimes ships counts as floats (e.g., "1234.0") or with
  // commas for thousands ("1,234"). Strip the noise.
  const cleaned = v.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sum the rows of an "App Store Discovery and Engagement Standard"
 * segment into the running rollup. Columns we care about (Apple's
 * canonical headers as of 2026-05):
 *   Date, Storefront, Source Type, Page Type, Impressions, Impressions
 *   Unique Device, Product Page Views, Total Downloads, Notification...
 *
 * Apple emits one row per (storefront × source × page-type) per day
 * so we sum across them for an app-level total.
 *
 * Returns true if at least one row was applied.
 */
function sumEngagementRows(tsv: string, into: DailyAnalyticsRow): ParserStats {
  const { headers, rows } = parseTsv(tsv);
  if (rows.length === 0) return { rows: 0, applied: 0 };
  // Apple's Discovery & Engagement reports use these column headers as
  // of 2026-05. The colon variant ("Impressions: Unique Devices") is
  // the deduped count; we prefer the raw count because we sum across
  // (source × page-type) rows. The aliases without colon are kept for
  // header-drift resilience — Apple has renamed these columns twice
  // in the past two years.
  const impCol = findColumn(headers, [
    "Impressions",
    "Impressions: Unique Devices",
    "Impressions Unique Device",
  ]);
  const pvCol = findColumn(headers, [
    "Product Page Views",
    "Product Page Views: Unique Devices",
    "Product Page Views Unique Device",
  ]);
  const dlCol = findColumn(headers, ["Total Downloads", "Downloads"]);
  let applied = 0;
  for (const row of rows) {
    const imp = impCol >= 0 ? toNum(row[impCol]) : 0;
    const pv = pvCol >= 0 ? toNum(row[pvCol]) : 0;
    const dl = dlCol >= 0 ? toNum(row[dlCol]) : 0;
    into.impressions += imp;
    into.pageViews += pv;
    into.downloads += dl;
    if (imp > 0 || pv > 0 || dl > 0) applied += 1;
  }
  return { rows: rows.length, applied };
}

/**
 * "App Downloads Standard" — has Date, Storefront, App Apple Identifier,
 * Source Type, Download Type ("First-Time download" | "Redownload"),
 * Counts.
 */
function sumDownloadsRows(tsv: string, into: DailyAnalyticsRow): ParserStats {
  const { headers, rows } = parseTsv(tsv);
  if (rows.length === 0) return { rows: 0, applied: 0 };
  const typeCol = findColumn(headers, ["Download Type", "Type"]);
  const cntCol = findColumn(headers, ["Counts", "Count", "Downloads"]);
  if (cntCol < 0) return { rows: rows.length, applied: 0 };
  let applied = 0;
  for (const row of rows) {
    const cnt = toNum(row[cntCol]);
    if (cnt === 0) continue;
    const t = (typeCol >= 0 ? (row[typeCol] ?? "") : "").toLowerCase();
    if (t.includes("redownload") || t.includes("re-download")) {
      into.redownloads += cnt;
    } else if (t.includes("first")) {
      into.firstTimeDownloads += cnt;
    } else {
      // unknown bucket — fall back to firstTime so the totals still tally
      into.firstTimeDownloads += cnt;
    }
    applied += 1;
  }
  return { rows: rows.length, applied };
}

/**
 * "App Sessions Standard" — Date, Storefront, Source Type, Sessions,
 * Active Devices, Active Devices Last 30 Days, etc. Apple keeps
 * renaming the active-device columns so we tolerate several aliases.
 */
function sumSessionsRows(tsv: string, into: DailyAnalyticsRow): ParserStats {
  const { headers, rows } = parseTsv(tsv);
  if (rows.length === 0) return { rows: 0, applied: 0 };
  const sessCol = findColumn(headers, ["Sessions", "Total Sessions"]);
  const active1Col = findColumn(headers, [
    "Active Devices",
    "Active Last 24 Hours",
    "Daily Active Devices",
  ]);
  const active7Col = findColumn(headers, [
    "Active Devices Last 7 Days",
    "Active Last 7 Days",
    "Weekly Active Devices",
  ]);
  const active30Col = findColumn(headers, [
    "Active Devices Last 30 Days",
    "Active Last 30 Days",
    "Monthly Active Devices",
  ]);
  let applied = 0;
  for (const row of rows) {
    const sess = sessCol >= 0 ? toNum(row[sessCol]) : 0;
    into.sessions += sess;
    // Active-device columns are SNAPSHOT-style — take the max across rows
    // rather than summing, since the same device counts once globally.
    const ad1 = active1Col >= 0 ? toNum(row[active1Col]) : 0;
    const ad7 = active7Col >= 0 ? toNum(row[active7Col]) : 0;
    const ad30 = active30Col >= 0 ? toNum(row[active30Col]) : 0;
    if (ad1 > 0) into.activeDevices1d = Math.max(into.activeDevices1d, ad1);
    if (ad7 > 0) into.activeDevices7d = Math.max(into.activeDevices7d, ad7);
    if (ad30 > 0) into.activeDevices30d = Math.max(into.activeDevices30d, ad30);
    if (sess > 0 || ad1 > 0 || ad7 > 0 || ad30 > 0) applied += 1;
  }
  return { rows: rows.length, applied };
}

/** "App Crashes" — Date, Storefront, App Version, Device, Counts. */
function sumCrashesRows(tsv: string, into: DailyAnalyticsRow): ParserStats {
  const { headers, rows } = parseTsv(tsv);
  if (rows.length === 0) return { rows: 0, applied: 0 };
  const cntCol = findColumn(headers, ["Counts", "Count", "Crashes"]);
  if (cntCol < 0) return { rows: rows.length, applied: 0 };
  let applied = 0;
  for (const row of rows) {
    const cnt = toNum(row[cntCol]);
    into.crashes += cnt;
    if (cnt > 0) applied += 1;
  }
  return { rows: rows.length, applied };
}

/** Apple's "Discovery and Engagement" rows have a `Source Type` column —
 *  map their strings into our enum. */
function mapSource(raw: string): SourceFunnelRow["source"] {
  const v = raw.toUpperCase();
  if (v.includes("SEARCH")) return "SEARCH";
  if (v.includes("BROWSE") || v.includes("EXPLORE") || v.includes("STORE_BROWSE")) return "BROWSE";
  if (v.includes("WEB")) return "WEB_REFERRER";
  if (v.includes("APP")) return "APP_REFERRER";
  if (v.includes("INSTITUTIONAL") || v.includes("VPP")) return "INSTITUTIONAL";
  return "UNAVAILABLE";
}

/** Apple's storefront column is a 3-letter ISO code ("USA") or a country
 *  name; normalise both to ISO 3166-1 alpha-2 where possible, falling
 *  back to "ALL". */
function mapTerritory(raw: string): string {
  if (!raw) return "ALL";
  const upper = raw.toUpperCase();
  if (upper.length === 3 && ISO3_TO_ISO2[upper]) return ISO3_TO_ISO2[upper];
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) return upper;
  return "ALL";
}

function parseDiscoveryRows(tsv: string, date: string): SourceFunnelRow[] {
  const { headers, rows } = parseTsv(tsv);
  if (rows.length === 0) return [];
  const srcCol = findColumn(headers, ["Source Type", "Acquisition Source"]);
  const terrCol = findColumn(headers, ["Storefront", "Storefront Code", "Territory"]);
  const impCol = findColumn(headers, ["Impressions"]);
  const pvCol = findColumn(headers, ["Product Page Views"]);
  const dlCol = findColumn(headers, ["Downloads", "Total Downloads"]);

  // Aggregate by (source, territory)
  const bucket = new Map<
    string,
    { source: SourceFunnelRow["source"]; territory: string; imp: number; pv: number; dl: number }
  >();
  for (const row of rows) {
    const source = mapSource(srcCol >= 0 ? (row[srcCol] ?? "") : "UNAVAILABLE");
    const territory = mapTerritory(terrCol >= 0 ? (row[terrCol] ?? "") : "");
    const key = `${source}::${territory}`;
    const cur = bucket.get(key) ?? { source, territory, imp: 0, pv: 0, dl: 0 };
    if (impCol >= 0) cur.imp += toNum(row[impCol]);
    if (pvCol >= 0) cur.pv += toNum(row[pvCol]);
    if (dlCol >= 0) cur.dl += toNum(row[dlCol]);
    bucket.set(key, cur);
  }
  return Array.from(bucket.values()).map((b) => ({
    date,
    source: b.source,
    territory: b.territory,
    impressions: b.imp,
    pageViews: b.pv,
    downloads: b.dl,
  }));
}

// Compact lookup for the most common storefronts. Anything missing
// degrades to "ALL" which the UI treats as the global rollup bucket.
const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US",
  GBR: "GB",
  DEU: "DE",
  FRA: "FR",
  ESP: "ES",
  ITA: "IT",
  NLD: "NL",
  TUR: "TR",
  JPN: "JP",
  KOR: "KR",
  CHN: "CN",
  IND: "IN",
  BRA: "BR",
  MEX: "MX",
  CAN: "CA",
  AUS: "AU",
  NZL: "NZ",
  RUS: "RU",
  POL: "PL",
  SWE: "SE",
  NOR: "NO",
  DNK: "DK",
  FIN: "FI",
  IRL: "IE",
  PRT: "PT",
  BEL: "BE",
  AUT: "AT",
  CHE: "CH",
  GRC: "GR",
  CZE: "CZ",
  HUN: "HU",
  ROU: "RO",
  BGR: "BG",
  UKR: "UA",
  ISR: "IL",
  SAU: "SA",
  ARE: "AE",
  EGY: "EG",
  ZAF: "ZA",
  IDN: "ID",
  THA: "TH",
  VNM: "VN",
  PHL: "PH",
  MYS: "MY",
  SGP: "SG",
  HKG: "HK",
  TWN: "TW",
  ARG: "AR",
  CHL: "CL",
  COL: "CO",
  PER: "PE",
  PAK: "PK",
  BGD: "BD",
  LKA: "LK",
  KAZ: "KZ",
  AZE: "AZ",
  HRV: "HR",
  SVN: "SI",
  SVK: "SK",
  EST: "EE",
  LVA: "LV",
  LTU: "LT",
};
