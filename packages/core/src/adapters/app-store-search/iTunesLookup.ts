/**
 * Public iTunes Lookup adapter — fetch full metadata for ONE App Store
 * listing by its numeric `trackId` (a.k.a. App Store ID).
 *
 *   GET https://itunes.apple.com/lookup?id=6499209744&country=tr
 *
 * Unlike `iTunesSearch` (which is keyword-based), Lookup returns the
 * canonical record for a specific app in the requested storefront —
 * different content per country (localized name, screenshots, release
 * notes, ratings). We call it:
 *
 *   • Once on competitor ingest, to discover the canonical name +
 *     bundleId + initial snapshot of every tracked territory.
 *   • Once per (competitor × territory) every nightly sync, to detect
 *     changes (new version, new screenshots, rating delta, …).
 *
 * Auth: none. Apple does not publish a rate limit; ~3 req/s with 200 ms
 * jitter keeps us well under the practical 429 threshold the existing
 * Search adapter has been operating at since launch.
 *
 * URL parsing: see `parseAppStoreUrl` at the bottom of this file. We
 * accept any of the modern `apps.apple.com/{cc}/app/{slug}/id{trackId}`
 * variants plus the legacy `itunes.apple.com` host.
 */

/** Normalised, application-shape result. Field names mirror the
 *  database column names on `CompetitorSnapshot`. */
export interface ItunesLookupResult {
  /** Apple's numeric App Store ID (trackId). Stable across versions. */
  storeAppId: string;
  bundleId: string;
  name: string;
  /** Free-form description (no markup). Apple sometimes embeds the
   *  subtitle on the first line — callers do not split it; we expose
   *  what Apple sent. */
  description: string | null;
  /** Marketing subtitle. Older payloads don't include it; we read
   *  the field if present and otherwise return `null` rather than
   *  guessing. */
  subtitle: string | null;
  /** Release notes for the current version (the changelog string). */
  releaseNotes: string | null;
  version: string | null;
  /** ISO timestamp when the current version went live. */
  currentVersionReleaseDate: Date | null;
  /** Lifetime average user rating (0..5). */
  averageUserRating: number | null;
  /** Lifetime rating count. */
  userRatingCount: number | null;
  /** Average rating scoped to current version only. */
  averageUserRatingForCurrentVersion: number | null;
  /** Rating count scoped to current version only. */
  userRatingCountForCurrentVersion: number | null;
  /** High-res icon URL (artworkUrl512). */
  iconUrl: string | null;
  /** iPhone screenshot URLs in the order Apple returns them. */
  iphoneScreenshotUrls: string[];
  /** iPad screenshot URLs — empty array on iPhone-only apps. */
  ipadScreenshotUrls: string[];
  sellerName: string | null;
  primaryGenre: string | null;
  primaryGenreId: number | null;
  /** All genre names Apple tagged (e.g. ["Games", "Puzzle", "Casual"]). */
  genres: string[];
  contentAdvisoryRating: string | null;
  minimumOsVersion: string | null;
  /** ISO-639-1 codes the listing is localized into (e.g. ["EN", "TR"]). */
  languageCodes: string[];
  price: number | null;
  currency: string | null;
  formattedPrice: string | null;
  /** Apple's canonical App Store page URL for this listing+territory. */
  trackUrl: string | null;
}

/** Shape of the raw `/lookup` response. Defensive: every field is
 *  optional because Apple omits keys when the value is missing (e.g.
 *  `subtitle` is absent for most older apps).
 *
 *  Documentation: https://performance-partners.apple.com/search-api
 *  (Apple's Search-API docs cover the same response shape used by
 *  Lookup; field names like `trackId`, `trackName`, `screenshotUrls`
 *  are stable since 2015.) */
interface RawLookupHit {
  trackId?: number;
  bundleId?: string;
  trackName?: string;
  description?: string;
  /** Apple started returning this in 2017 for iOS 11+ apps. */
  subtitle?: string;
  releaseNotes?: string;
  version?: string;
  currentVersionReleaseDate?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  averageUserRatingForCurrentVersion?: number;
  userRatingCountForCurrentVersion?: number;
  artworkUrl512?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  appletvScreenshotUrls?: string[];
  sellerName?: string;
  artistName?: string;
  primaryGenreName?: string;
  primaryGenreId?: number;
  genres?: string[];
  contentAdvisoryRating?: string;
  minimumOsVersion?: string;
  languageCodesISO2A?: string[];
  price?: number;
  currency?: string;
  formattedPrice?: string;
  trackViewUrl?: string;
}

interface RawLookupResponse {
  resultCount: number;
  results: RawLookupHit[];
}

export interface LookupOptions {
  /** Numeric App Store ID. Pass as a string to preserve precision —
   *  ids exceed JS safe-integer range in some edge cases. */
  storeAppId: string;
  /** ISO 3166-1 alpha-2, e.g. `US`, `TR`. Maps to iTunes `country=`.
   *  Case-insensitive; we lowercase before sending. */
  country: string;
  /** Request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/**
 * Look up a specific App Store listing in a specific storefront.
 *
 * Returns `null` when Apple says the app does not exist in that
 * storefront (`resultCount === 0`) — a not-found is a legitimate
 * outcome (e.g. an app pulled from Turkey but still live in the US),
 * not an exception. Throws only on network failure / malformed JSON.
 */
export async function iTunesLookup(
  opts: LookupOptions,
): Promise<ItunesLookupResult | null> {
  const country = opts.country.toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) {
    throw new Error(`iTunesLookup: invalid country code "${opts.country}"`);
  }
  if (!/^\d+$/.test(opts.storeAppId)) {
    throw new Error(`iTunesLookup: storeAppId must be numeric, got "${opts.storeAppId}"`);
  }

  const params = new URLSearchParams({
    id: opts.storeAppId,
    country,
    entity: "software",
  });
  const url = `https://itunes.apple.com/lookup?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`iTunesLookup: HTTP ${res.status.toString()}`);
    }
    const raw = (await res.json()) as RawLookupResponse;
    if (!raw.results || raw.results.length === 0) return null;
    return normalize(raw.results[0]!);
  } finally {
    clearTimeout(timer);
  }
}

function normalize(hit: RawLookupHit): ItunesLookupResult {
  return {
    storeAppId: hit.trackId != null ? hit.trackId.toString() : "",
    bundleId: hit.bundleId ?? "",
    name: hit.trackName ?? "",
    description: hit.description ?? null,
    subtitle: hit.subtitle ?? null,
    releaseNotes: hit.releaseNotes ?? null,
    version: hit.version ?? null,
    currentVersionReleaseDate: hit.currentVersionReleaseDate
      ? new Date(hit.currentVersionReleaseDate)
      : null,
    averageUserRating: numericOrNull(hit.averageUserRating),
    userRatingCount: numericOrNull(hit.userRatingCount),
    averageUserRatingForCurrentVersion: numericOrNull(
      hit.averageUserRatingForCurrentVersion,
    ),
    userRatingCountForCurrentVersion: numericOrNull(
      hit.userRatingCountForCurrentVersion,
    ),
    // Prefer 512px artwork when available; fall back to 100 → 60.
    iconUrl: hit.artworkUrl512 ?? hit.artworkUrl100 ?? hit.artworkUrl60 ?? null,
    iphoneScreenshotUrls: Array.isArray(hit.screenshotUrls)
      ? hit.screenshotUrls
      : [],
    ipadScreenshotUrls: Array.isArray(hit.ipadScreenshotUrls)
      ? hit.ipadScreenshotUrls
      : [],
    sellerName: hit.sellerName ?? hit.artistName ?? null,
    primaryGenre: hit.primaryGenreName ?? null,
    primaryGenreId: hit.primaryGenreId ?? null,
    genres: Array.isArray(hit.genres) ? hit.genres : [],
    contentAdvisoryRating: hit.contentAdvisoryRating ?? null,
    minimumOsVersion: hit.minimumOsVersion ?? null,
    languageCodes: Array.isArray(hit.languageCodesISO2A)
      ? hit.languageCodesISO2A
      : [],
    price: numericOrNull(hit.price),
    currency: hit.currency ?? null,
    formattedPrice: hit.formattedPrice ?? null,
    trackUrl: hit.trackViewUrl ?? null,
  };
}

function numericOrNull(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ──────────────────────────────────────────────────────────────────────
// URL parser — extract storeAppId + country from an App Store URL
// ──────────────────────────────────────────────────────────────────────

export interface ParsedAppStoreUrl {
  storeAppId: string;
  /** 2-letter ISO country code, lowercased. Defaults to `"us"` when
   *  the URL omits the storefront prefix (e.g. `apps.apple.com/app/...`). */
  country: string;
  /** App slug (the dashed word between `/app/` and `/id`), if Apple
   *  included one. Used only for display; the canonical fetch keys
   *  off storeAppId. */
  slug: string | null;
}

const URL_PATTERN =
  /^https?:\/\/(?:apps|itunes)\.apple\.com(?:\/(?<country>[a-z]{2}))?\/app(?:\/(?<slug>[^/]+))?\/id(?<id>\d+)/i;

/**
 * Parse any common App Store URL format into its components.
 *
 *   https://apps.apple.com/tr/app/magic-sort/id6499209744       → { country: "tr", slug: "magic-sort",  storeAppId: "6499209744" }
 *   https://apps.apple.com/us/app/id123456789                   → { country: "us", slug: null,          storeAppId: "123456789" }
 *   https://apps.apple.com/app/id6499209744                     → { country: "us", slug: null,          storeAppId: "6499209744" } (no-cc → us)
 *   https://itunes.apple.com/de/app/wonderbox/id987654321?mt=8  → { country: "de", slug: "wonderbox",  storeAppId: "987654321" }
 *
 * Returns `null` on anything we don't recognise — the caller decides
 * whether to fall back to manual entry or surface an error toast.
 */
export function parseAppStoreUrl(input: string): ParsedAppStoreUrl | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const m = URL_PATTERN.exec(trimmed);
  if (!m?.groups) return null;
  const id = m.groups.id;
  if (!id) return null;
  return {
    storeAppId: id,
    country: (m.groups.country ?? "us").toLowerCase(),
    slug: m.groups.slug ?? null,
  };
}
