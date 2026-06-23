/**
 * Public iTunes Search adapter — no auth required.
 *
 *   GET https://itunes.apple.com/search?term=X&country=US&entity=software&limit=50
 *
 * Returns the App Store top results for a search term in a given
 * storefront. We use this to:
 *
 *   1. Find OUR app's rank for a tracked keyword (looped daily by the
 *      `aso.keywords.scan` worker).
 *   2. List the competitor apps that rank for that keyword (used by
 *      the AI provider to suggest "borrowed" keywords).
 *
 * Rate limit: Apple doesn't publish one, but at ~3 req/s we never hit
 * 429s in practice. The worker adds 200ms jitter between calls.
 */

export interface ItunesSearchResult {
  appStoreId: number; // trackId
  bundleId: string; // bundleId
  name: string; // trackName
  developer: string; // artistName
  iconUrl: string | null; // artworkUrl512
  averageRating: number | null;
  ratingCount: number | null;
  primaryGenre: string | null;
}

export interface ItunesSearchResponse {
  results: ItunesSearchResult[];
  /** Position of `ourBundleId` in `results`, 1-indexed. null when off-list. */
  ourRank: number | null;
}

interface RawSearchResponse {
  resultCount: number;
  results: {
    trackId: number;
    bundleId: string;
    trackName: string;
    artistName: string;
    artworkUrl512?: string;
    artworkUrl100?: string;
    averageUserRating?: number;
    userRatingCount?: number;
    primaryGenreName?: string;
  }[];
}

export interface SearchOptions {
  term: string;
  /** ISO 3166-1 alpha-2 (`US`, `TR`, `DE`, …). Maps to itunes `country` param. */
  country: string;
  /** 1-200. Defaults to 50 (rank tracker needs first 50 to bucket rank). */
  limit?: number;
  /** Compare against this bundle id to compute `ourRank`. */
  ourBundleId?: string;
  /** Request timeout in ms. Default 8s — itunes rarely takes that long. */
  timeoutMs?: number;
}

/**
 * Search the App Store for a term in a specific storefront.
 * Throws on network failure, returns empty `results` on no matches.
 */
export async function iTunesSearch(opts: SearchOptions): Promise<ItunesSearchResponse> {
  const params = new URLSearchParams({
    term: opts.term,
    country: opts.country.toLowerCase(),
    entity: "software",
    limit: String(opts.limit ?? 50),
  });
  const url = `https://itunes.apple.com/search?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`iTunes search returned HTTP ${res.status.toString()}`);
    }
    const json = (await res.json()) as RawSearchResponse;
    const results: ItunesSearchResult[] = json.results.map((r) => ({
      appStoreId: r.trackId,
      bundleId: r.bundleId,
      name: r.trackName,
      developer: r.artistName,
      iconUrl: r.artworkUrl512 ?? r.artworkUrl100 ?? null,
      averageRating: r.averageUserRating ?? null,
      ratingCount: r.userRatingCount ?? null,
      primaryGenre: r.primaryGenreName ?? null,
    }));

    let ourRank: number | null = null;
    if (opts.ourBundleId) {
      const idx = results.findIndex((r) => r.bundleId === opts.ourBundleId);
      ourRank = idx >= 0 ? idx + 1 : null;
    }
    return { results, ourRank };
  } finally {
    clearTimeout(timer);
  }
}
