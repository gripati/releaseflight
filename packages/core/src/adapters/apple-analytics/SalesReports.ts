/**
 * App Store Connect — Sales and Trends Reports adapter.
 *
 *   GET /v1/salesReports
 *     filter[frequency]      DAILY | WEEKLY | MONTHLY | YEARLY
 *     filter[reportSubType]  SUMMARY | DETAILED | …
 *     filter[reportType]     SALES (for Units + proceeds)
 *     filter[reportDate]     YYYY-MM-DD (the day for DAILY)
 *     filter[vendorNumber]   numeric, owner's vendor ID
 *
 * Returns: gzipped TSV. We parse the rows, filter to the app we care
 * about (matched by `Apple Identifier`), drop in-app-purchase rows
 * (Product Type Identifier starting with `IA`), and aggregate.
 *
 * Why this matters: this API has been around since 2010 and works
 * from the first sale onward — there is NO privacy threshold, unlike
 * the newer Analytics Reports endpoints which won't unlock until
 * the app has ~1000 monthly active users.
 */
import { gunzipSync } from "node:zlib";
import type { AppleClient } from "../apple/AppleClient";

export interface SalesReportRow {
  /** Apple Identifier — matches `App.storeAppId`. */
  appleId: string;
  /** YYYY-MM-DD of the begin date. */
  date: string;
  /** ISO 3166-1 alpha-2 storefront. */
  countryCode: string;
  /** "iPhone" | "iPad" | "Desktop" | "Apple TV" | …  */
  device: string;
  /** New downloads on that day for that (territory × device). */
  units: number;
  /** Customer-paid amount × Units, in customer currency. */
  customerPrice: number;
  /** Developer proceeds, in proceeds currency. */
  developerProceeds: number;
  /** "1" / "1F" / "7" / "IA1" etc — useful to split downloads vs IAP. */
  productTypeIdentifier: string;
}

export interface DailyUnitsSummary {
  date: string;
  appleId: string;
  /** New + universal app downloads (Product Type 1, 1F). */
  units: number;
  /** Updates (Product Type 7, 7F). */
  updates: number;
  /** In-app purchase units (IA1, IA9, IAY etc.). */
  inAppUnits: number;
  perTerritory: Map<string, number>;
  perDevice: Map<string, number>;
}

const DOWNLOAD_PRODUCT_TYPES = new Set([
  "1",
  "1F",
  "1T",
  "1E",
  "1EP",
  "1EU",
  "F1",
]);
const UPDATE_PRODUCT_TYPES = new Set(["7", "7F", "7T", "7E"]);

export class SalesReports {
  constructor(private readonly client: AppleClient) {}

  /**
   * Fetch and parse the DAILY Sales Summary for a specific date +
   * vendor. Filters rows to the app we care about and returns a
   * summary keyed by date with per-territory and per-device totals.
   *
   * Apple returns `404 / no data` when:
   *   • The report for that day isn't ready yet (typically ready by
   *     ~12:00 UTC of the following day).
   *   • The vendor had zero sales globally on that day.
   * We swallow that into an empty summary.
   */
  async getDailySummary(opts: {
    vendorNumber: string;
    date: string; // YYYY-MM-DD
    appleId: string;
  }): Promise<DailyUnitsSummary | null> {
    const tsv = await this.fetchReport({
      vendorNumber: opts.vendorNumber,
      reportDate: opts.date,
      frequency: "DAILY",
      reportSubType: "SUMMARY",
      reportType: "SALES",
    });
    if (!tsv) return null;
    const rows = parseSalesTsv(tsv).filter((r) => r.appleId === opts.appleId);
    if (rows.length === 0) {
      return {
        date: opts.date,
        appleId: opts.appleId,
        units: 0,
        updates: 0,
        inAppUnits: 0,
        perTerritory: new Map(),
        perDevice: new Map(),
      };
    }
    const summary: DailyUnitsSummary = {
      date: opts.date,
      appleId: opts.appleId,
      units: 0,
      updates: 0,
      inAppUnits: 0,
      perTerritory: new Map(),
      perDevice: new Map(),
    };
    for (const r of rows) {
      const pti = r.productTypeIdentifier;
      const isDownload = DOWNLOAD_PRODUCT_TYPES.has(pti);
      const isUpdate = UPDATE_PRODUCT_TYPES.has(pti);
      const isIap = pti.startsWith("IA");
      if (isDownload) {
        summary.units += r.units;
        summary.perTerritory.set(
          r.countryCode,
          (summary.perTerritory.get(r.countryCode) ?? 0) + r.units,
        );
        if (r.device) {
          summary.perDevice.set(r.device, (summary.perDevice.get(r.device) ?? 0) + r.units);
        }
      } else if (isUpdate) {
        summary.updates += r.units;
      } else if (isIap) {
        summary.inAppUnits += r.units;
      }
    }
    return summary;
  }

  /**
   * Low-level: fetch one report's gzipped TSV body and decompress.
   * Returns null on 404 (no data for that date). All other errors
   * bubble up.
   */
  async fetchReport(opts: {
    vendorNumber: string;
    reportDate: string;
    frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    reportSubType: "SUMMARY" | "DETAILED" | "SUMMARY_INSTALL_TYPE" | "OPT_IN";
    reportType: "SALES" | "SUBSCRIPTION" | "SUBSCRIPTION_EVENT" | "SUBSCRIBER" | "PRE_ORDER";
  }): Promise<string | null> {
    const buf = await this.client.requestRaw({
      path: "/salesReports",
      query: {
        "filter[frequency]": opts.frequency,
        "filter[reportSubType]": opts.reportSubType,
        "filter[reportType]": opts.reportType,
        "filter[reportDate]": opts.reportDate,
        "filter[vendorNumber]": opts.vendorNumber,
        "filter[version]": "1_0",
      },
      accept: "application/a-gzip, application/json",
    });
    if (!buf) return null;
    const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const body = isGzip ? gunzipSync(buf) : buf;
    return body.toString("utf8");
  }
}

// ──────────────────────────────────────────────────────────────────

export function parseSalesTsv(text: string): SalesReportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0]!.split("\t").map((h) => h.trim());
  const idx = (n: string): number => headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const appleIdCol = idx("Apple Identifier");
  const beginCol = idx("Begin Date");
  const countryCol = idx("Country Code");
  const deviceCol = idx("Device");
  const unitsCol = idx("Units");
  const customerPriceCol = idx("Customer Price");
  const proceedsCol = idx("Developer Proceeds");
  const ptiCol = idx("Product Type Identifier");

  const out: SalesReportRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split("\t");
    if (cells.length < headers.length) continue;
    out.push({
      appleId: cells[appleIdCol]?.trim() ?? "",
      date: normaliseDate(cells[beginCol]?.trim() ?? ""),
      countryCode: cells[countryCol]?.trim() ?? "",
      device: cells[deviceCol]?.trim() ?? "",
      units: toNum(cells[unitsCol]),
      customerPrice: toNum(cells[customerPriceCol]),
      developerProceeds: toNum(cells[proceedsCol]),
      productTypeIdentifier: cells[ptiCol]?.trim() ?? "",
    });
  }
  return out;
}

function toNum(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Apple Sales reports use MM/DD/YYYY in the Begin Date column. Normalise
 * to ISO YYYY-MM-DD so callers can join with our own date columns.
 */
function normaliseDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (m) return `${m[3]!}-${m[1]!}-${m[2]!}`;
  return raw;
}
