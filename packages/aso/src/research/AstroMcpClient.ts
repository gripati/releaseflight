/**
 * Astro MCP client — speaks the **real** Astro Desktop MCP protocol
 * documented at https://tryastro.app/docs/mcp/.
 *
 * Astro exposes a richer surface than the generic "lookup metrics per
 * keyword" we originally assumed. The toolkit lets us:
 *
 *   • register an app for tracking            (add_app)
 *   • push our keywords up to Astro            (add_keywords, batch ≤ 100)
 *   • read Astro's tracked apps + keywords     (list_apps / get_app_keywords)
 *   • pull ranking + popularity per keyword    (search_rankings)
 *   • ask Astro for AI-suggested keywords      (get_keyword_suggestions)
 *   • mine competitor keywords for a seed term (extract_competitors_keywords)
 *   • search the App Store live                (search_app_store)
 *
 * That last set is what powers our **autopilot** — we mirror our
 * tracked keywords into Astro, then ask Astro for stronger alternatives
 * the user can swap into the keywords field of each locale.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST. The MCP Streamable HTTP
 * variant — Astro Desktop binds to 127.0.0.1:8089 by default; remote
 * Astro deployments may use other hosts.
 *
 * Auth: optional Bearer token. Local Astro Desktop has none (relies on
 * the 60 req/min rate limit). Hosted instances may require a token.
 */

// NOTE: this module is reachable from client bundles via the @marquee/aso
// barrel (a client component imports the package), so it must stay free of
// Node-only imports. The SSRF guard for `endpoint` therefore lives at the
// SERVER call sites (see assertSafeMcpEndpoint in @marquee/core), invoked
// before the endpoint is handed to this client.

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_TOOL_CALL_RETRIES = 1;

/**
 * In the self-host docker deployment the web + worker run INSIDE containers, so a
 * loopback endpoint — the natural `http://127.0.0.1:8089/mcp` that Astro Desktop
 * shows the user — points at the container itself, not the host Mac where Astro
 * runs, and every request dies with "fetch failed". Transparently remap loopback
 * hosts to the docker host-gateway (`host.docker.internal`, overridable) so the
 * user's natural localhost URL just works. ONLY when DEPLOY_MODE=self_host — a
 * cloud deployment must never rewrite localhost (there is no host gateway, and a
 * loopback MCP URL there is genuinely invalid). The original endpoint already
 * passed the server-side SSRF guard (loopback is permitted in self-host), and the
 * gateway is the same trusted operator machine, so the remap changes nothing the
 * guard protects against.
 */
function resolveContainerEndpoint(endpoint: string): string {
  if (process.env.DEPLOY_MODE !== "self_host") return endpoint;
  try {
    const u = new URL(endpoint);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      u.hostname = process.env.MARQUEE_DOCKER_HOST_GATEWAY ?? "host.docker.internal";
      return u.toString();
    }
  } catch {
    // Malformed URL — leave it; the SSRF guard / fetch surfaces a clear error.
  }
  return endpoint;
}

/** Configuration for an Astro MCP HTTP endpoint. */
export interface AstroMcpClientConfig {
  /** Full URL — typically `http://127.0.0.1:8089/mcp` for Astro Desktop. */
  endpoint: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Override per-request timeout. Defaults to 20s. */
  timeoutMs?: number;
  /** How many times to retry a tools/call after a transport error.
   *  Defaults to 1 (so worst case = 2 attempts). */
  retries?: number;
  /** Override fetch (mostly for tests). */
  fetchImpl?: typeof fetch;
  /** Sustained throughput cap. Astro Desktop enforces 30 req/min as
   *  of v1; we default to 25 to leave headroom for the ASO research
   *  pipeline that also calls Astro. Set to 0 to disable. */
  requestsPerMinute?: number;
  /** Burst size — how many tokens the limiter starts with / can hold.
   *  Defaults to 5 so short flurries don't block. */
  burst?: number;
}

/**
 * Token-bucket limiter. Stays under Astro's 30 req/min cap by
 * default, with a small burst to absorb short flurries. All client
 * calls acquire a token before issuing the HTTP request.
 */
class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefill: number;
  // FIFO queue of pending acquire() resolvers — first call enqueued
  // gets the next available token.
  private readonly waiters: (() => void)[] = [];

  constructor(perMinute: number, burst: number) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillIntervalMs = Math.ceil(60_000 / Math.max(1, perMinute));
    this.lastRefill = Date.now();
  }

  /** Block until a token is available, then consume one. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.scheduleNextRefill();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const earned = Math.floor(elapsed / this.refillIntervalMs);
    if (earned > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + earned);
      this.lastRefill += earned * this.refillIntervalMs;
    }
    // Drain the waiter queue with whatever tokens we now have.
    while (this.tokens > 0 && this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next) {
        this.tokens -= 1;
        next();
      }
    }
  }

  private timer: ReturnType<typeof setTimeout> | null = null;

  private scheduleNextRefill(): void {
    if (this.timer) return;
    const since = Date.now() - this.lastRefill;
    const wait = Math.max(50, this.refillIntervalMs - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill();
      if (this.waiters.length > 0) this.scheduleNextRefill();
    }, wait);
  }
}

/** No-op limiter for tests / callers that opt out. */
class NoopLimiter {
  async acquire(): Promise<void> {
    /* nothing */
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

interface ToolsCallResult {
  content: { type: string; text?: string; data?: unknown }[];
  isError?: boolean;
}

// ── Public output shapes ─────────────────────────────────────────────

/** Subset of the `list_apps` row we care about. Astro returns more — we
 *  only consume the identifying fields. */
export interface AstroApp {
  /** Astro's own appId (NOT the App Store numeric id — those are stored
   *  in a separate field when Astro knows them). */
  id: string;
  appName: string;
  appStoreId?: string | null;
  bundleId?: string | null;
  store?: "ios" | "android" | string;
  country?: string | null;
}

/** A keyword Astro is currently tracking for a given app. */
export interface AstroTrackedKeyword {
  keyword: string;
  country: string;
  popularity?: number | null;
  rank?: number | null;
  volume?: number | null;
  difficulty?: number | null;
  maxReachChance?: number | null;
  lastSeenAt?: string | null;
}

/** One ranking sample returned by `search_rankings`. The `history`
 *  array is populated when the caller passed `includeHistory: true`
 *  — each entry is one timestamped rank observation Astro made. */
export interface AstroRankingSample {
  keyword: string;
  country: string;
  rank?: number | null;
  /** Astro's previous-snapshot rank — convenient for an inline Δ
   *  without parsing the full history array. Null on first observation. */
  previousRank?: number | null;
  popularity?: number | null;
  volume?: number | null;
  maxVolume?: number | null;
  difficulty?: number | null;
  maxReachChance?: number | null;
  capturedAt?: string | null;
  /** Per-snapshot rank history, newest first. Only set when
   *  `searchRankings()` was called with `includeHistory: true`. */
  history?: { date: string; ranking: number | null }[];
}

/** Astro's AI-suggested keyword for an app. */
export interface AstroKeywordSuggestion {
  keyword: string;
  country?: string | null;
  popularity?: number | null;
  volume?: number | null;
  difficulty?: number | null;
  maxReachChance?: number | null;
  /** Astro tags suggestions with a reason / cluster ("LONG_TAIL",
   *  "COMPETITOR", "BRAND" …) when available. */
  cluster?: string | null;
  /** Free-text reasoning Astro attached. May be null. */
  reason?: string | null;
}

/** Output of `extract_competitors_keywords` — a related-keyword sample
 *  mined from competitors who rank for the seed term. */
export interface AstroCompetitorKeyword {
  keyword: string;
  popularity?: number | null;
  rank?: number | null;
  competitorCount?: number | null;
  source?: string | null;
}

/** Per-keyword detail Astro returns inside `add_keywords.results[]`.
 *  This is HOW we cheaply enrich candidates from competitor mining
 *  with REAL Apple popularity + difficulty: send the candidates as a
 *  ≤100-batch and parse this array back. */
export interface AstroAddKeywordsPerResult {
  keyword: string;
  /** True App Store popularity 0-100 (Apple's index) — different from
   *  the competitor-frequency score `extract_competitors_keywords`
   *  returns. */
  popularity: number | null;
  /** App Store keyword difficulty 0-100. Lower = easier to rank. */
  difficulty: number | null;
  /** Our app's current rank for this keyword, when Astro knows.
   *  null when never observed. */
  ranking: number | null;
  /** True when Astro skipped this keyword (already tracked, invalid, etc). */
  skipped: boolean;
  /** Optional human-readable note when skipped (e.g. "Already tracked"). */
  error: string | null;
}

/** Result of an `add_keywords` call — Astro echoes the keywords it
 *  accepted and the ones it skipped (duplicates). */
export interface AstroAddKeywordsResult {
  added: number;
  skipped: number;
  /** List of keywords Astro rejected (already tracked / invalid). */
  skippedKeywords: string[];
  /** Per-keyword metrics Astro computed at insert time. Empty array
   *  when Astro returned only a text confirmation (the older protocol). */
  results: AstroAddKeywordsPerResult[];
}

// ── Client ───────────────────────────────────────────────────────────

export class AstroMcpClient {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: { acquire(): Promise<void> };
  private rpcId = 0;

  constructor(config: AstroMcpClientConfig) {
    this.endpoint = resolveContainerEndpoint(config.endpoint);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = config.retries ?? DEFAULT_TOOL_CALL_RETRIES;
    this.fetchImpl = config.fetchImpl ?? fetch;
    const rpm = config.requestsPerMinute ?? 25;
    const burst = config.burst ?? 5;
    this.limiter = rpm > 0 ? new RateLimiter(rpm, burst) : new NoopLimiter();
  }

  // ── Discovery / health ─────────────────────────────────────────────

  /** Tiny one-shot health probe — calls `list_apps` and returns true if
   *  the server responded with a valid MCP envelope. Used by the
   *  "Test connection" credential flow. */
  async ping(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.callTool("list_apps", {});
      return { ok: true, message: "Astro MCP responded — connection OK" };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── App management ─────────────────────────────────────────────────

  async listApps(): Promise<AstroApp[]> {
    const raw = await this.callTool("list_apps", {});
    return coerceArray<AstroApp>(raw, mapAstroApp);
  }

  /** Ensure an app is registered for tracking. Astro requires the
   *  App Store numeric id under the key `appStoreId`. Idempotent — a
   *  "Duplicate entry" tool error is treated as success and surfaced
   *  via `alreadyTracked: true` so callers can distinguish first-time
   *  registration from a no-op. */
  async addApp(params: {
    appStoreId: string;
  }): Promise<{ alreadyTracked: boolean; app: AstroApp | null }> {
    if (!params.appStoreId) {
      throw new Error("addApp requires appStoreId");
    }
    try {
      const raw = await this.callTool("add_app", params);
      const list = coerceArray<AstroApp>(raw, mapAstroApp);
      return { alreadyTracked: false, app: list[0] ?? null };
    } catch (err) {
      if (err instanceof Error && /duplicate entry/i.test(err.message)) {
        return { alreadyTracked: true, app: null };
      }
      throw err;
    }
  }

  async getAppKeywords(params: {
    appName?: string;
    appId?: string;
  }): Promise<AstroTrackedKeyword[]> {
    const raw = await this.callTool("get_app_keywords", params);
    return coerceArray<AstroTrackedKeyword>(raw, mapTrackedKeyword);
  }

  // ── Keyword sync ───────────────────────────────────────────────────

  /** Push up to 100 keywords to Astro for a single app/store. The
   *  caller is responsible for chunking >100 keywords.
   *
   *  Astro's parameter shape:
   *    {
   *      appId:    App Store numeric id,
   *      store:    LOWERCASE storefront ("us", "tr", "de", …),
   *      keywords: string[],
   *    }
   *  This is the storefront (country) — NOT the platform. */
  async addKeywords(params: {
    appId: string;
    /** Lowercase storefront / country code ("us", "tr", "de", …). */
    store: string;
    keywords: string[];
  }): Promise<AstroAddKeywordsResult> {
    if (params.keywords.length === 0) {
      return { added: 0, skipped: 0, skippedKeywords: [], results: [] };
    }
    if (params.keywords.length > 100) {
      throw new Error(
        `add_keywords supports at most 100 keywords per call; got ${params.keywords.length.toString()}. Chunk before calling.`,
      );
    }
    const raw = await this.callTool("add_keywords", {
      appId: params.appId,
      store: params.store.toLowerCase(),
      keywords: params.keywords,
    });
    return mapAddKeywordsResult(raw, params.keywords);
  }

  /** Chunked helper — handles any number of keywords by slicing into
   *  ≤100-token batches and aggregating results. */
  async addKeywordsBulk(params: {
    appId: string;
    store: string;
    keywords: string[];
  }): Promise<AstroAddKeywordsResult> {
    const chunks: string[][] = [];
    for (let i = 0; i < params.keywords.length; i += 100) {
      chunks.push(params.keywords.slice(i, i + 100));
    }
    const result: AstroAddKeywordsResult = {
      added: 0,
      skipped: 0,
      skippedKeywords: [],
      results: [],
    };
    for (const chunk of chunks) {
      const r = await this.addKeywords({ ...params, keywords: chunk });
      result.added += r.added;
      result.skipped += r.skipped;
      result.skippedKeywords.push(...r.skippedKeywords);
      result.results.push(...r.results);
    }
    return result;
  }

  // ── Research ───────────────────────────────────────────────────────

  /** Single-keyword ranking + popularity lookup. `store` is the
   *  lowercase storefront (Astro returns 404-style empty array if the
   *  keyword isn't tracked yet for that store). */
  async searchRankings(params: {
    keyword: string;
    store: string;
    includeHistory?: boolean;
  }): Promise<AstroRankingSample[]> {
    const raw = await this.callTool("search_rankings", {
      keyword: params.keyword,
      store: params.store.toLowerCase(),
      ...(params.includeHistory !== undefined && { includeHistory: params.includeHistory }),
    });
    return coerceArray<AstroRankingSample>(raw, mapRankingSample);
  }

  /** AI-driven keyword suggestions Astro generates for one app + store. */
  async getKeywordSuggestions(params: {
    appId: string;
    store: string;
  }): Promise<AstroKeywordSuggestion[]> {
    const raw = await this.callTool("get_keyword_suggestions", {
      appId: params.appId,
      store: params.store.toLowerCase(),
    });
    return coerceArray<AstroKeywordSuggestion>(raw, mapSuggestion);
  }

  /** Find competitor-derived keyword combinations seeded from a
   *  tracked term. Astro requires the seed `keyword` to already be
   *  tracked in `(appId, store)` — push your keywords first. */
  async extractCompetitorsKeywords(params: {
    keyword: string;
    appId: string;
    store: string;
  }): Promise<AstroCompetitorKeyword[]> {
    const raw = await this.callTool("extract_competitors_keywords", {
      keyword: params.keyword,
      appId: params.appId,
      store: params.store.toLowerCase(),
    });
    return coerceArray<AstroCompetitorKeyword>(raw, mapCompetitorKeyword);
  }

  // ── Low-level transport ────────────────────────────────────────────

  /** Generic tools/call dispatcher with three layers of protection:
   *
   *   1. Token-bucket rate limiter (Astro caps at 30 req/min — we
   *      default to 25 to leave headroom for the worker pipeline).
   *   2. Automatic retry on "rate limit" tool errors — we parse
   *      Astro's "wait N minute(s)" message, sleep, and try again.
   *   3. One transport retry for network blips. Tool errors that are
   *      NOT rate-limit are deterministic and never retried.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    // Up to 2 rate-limit retries — one short (~5s) and one longer
    // (60s) to cover the worst case where the limiter token bucket
    // got out of sync with the server's own counter.
    let rateLimitRetries = 2;

    for (;;) {
      // Acquire a token before each attempt so we self-throttle.
      await this.limiter.acquire();
      let rateLimited = false;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await this.callToolOnce(name, args);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Astro tool error:")) {
            const waitMs = parseRateLimitWaitMs(err.message);
            if (waitMs > 0 && rateLimitRetries > 0) {
              rateLimitRetries -= 1;
              await sleep(waitMs);
              rateLimited = true;
              break; // re-acquire token + retry
            }
            throw err; // non-rate-limit tool error → don't retry
          }
          // Transport/parse error — retry with exponential backoff.
          if (attempt === this.retries) throw err;
          await sleep(200 * (attempt + 1));
        }
      }
      if (!rateLimited) {
        // Unreachable in practice — callToolOnce either returns or
        // throws within the inner for. The fall-through is a guard
        // against future refactors.
        throw new Error("Astro MCP: exhausted retries without resolution");
      }
    }
  }

  private async callToolOnce(name: string, args: Record<string, unknown>): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const envelope = await this.post<JsonRpcResponse<ToolsCallResult>>(req);
    if ("error" in envelope) {
      throw new Error(`Astro MCP error: ${envelope.error.message}`);
    }
    const result = envelope.result;
    if (result.isError) {
      const msg = result.content
        .map((c) => c.text ?? "")
        .join(" ")
        .trim();
      throw new Error(`Astro tool error: ${msg || "unknown"}`);
    }
    for (const block of result.content) {
      if (block.data !== undefined) return block.data;
      if (typeof block.text === "string") {
        try {
          return JSON.parse(block.text);
        } catch {
          continue;
        }
      }
    }
    // Some Astro tools return only a confirmation string ("Added 12
    // keywords, skipped 3"). Surface the raw text so the mapper can
    // pattern-match it instead of failing outright.
    const joined = result.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n")
      .trim();
    if (joined.length > 0) return { __astroText: joined };
    throw new Error("Astro MCP returned no parseable content");
  }

  private async post<T>(body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Do NOT reflect the upstream response body — for a user-supplied
        // endpoint that would leak the content of internal services. Status only.
        throw new Error(`Astro MCP HTTP ${res.status.toString()}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Tolerant mappers ─────────────────────────────────────────────────
//
// Astro's field names shift across tool versions. We accept the
// documented names + a couple of common aliases so an upgrade to the
// next Astro release doesn't break the integration. Anything we can't
// recognise becomes `null` — the autopilot ignores rows where the
// signals are entirely missing.

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function coerceArray<T>(raw: unknown, mapper: (r: Record<string, unknown>) => T): T[] {
  if (Array.isArray(raw)) {
    const out: T[] = [];
    for (const item of raw) {
      const rec = asRecord(item);
      if (rec) out.push(mapper(rec));
    }
    return out;
  }
  const rec = asRecord(raw);
  if (rec) {
    // Some tools return { items: [...] } or { keywords: [...] }
    for (const key of ["items", "keywords", "apps", "rankings", "suggestions", "data"]) {
      const v = rec[key];
      if (Array.isArray(v)) {
        return coerceArray<T>(v, mapper);
      }
    }
    // Single-object response → wrap into a one-element array
    return [mapper(rec)];
  }
  return [];
}

function mapAstroApp(r: Record<string, unknown>): AstroApp {
  // Astro's list_apps returns `appId` as the App Store numeric id —
  // that's both the identifier we pass back AND the appStoreId.
  const astroAppId = str(r.appId ?? r.id ?? r.astroId) ?? "";
  return {
    id: astroAppId,
    appName: str(r.name ?? r.appName) ?? "",
    appStoreId: str(r.appStoreId ?? r.storeId ?? r.trackId) ?? astroAppId,
    bundleId: str(r.bundleId ?? r.bundleIdentifier),
    store: str(r.platform ?? r.store) ?? undefined,
    country: str(r.country ?? r.storefront),
  };
}

function mapTrackedKeyword(r: Record<string, unknown>): AstroTrackedKeyword {
  return {
    keyword: str(r.keyword) ?? "",
    country: str(r.country ?? r.storefront) ?? "",
    popularity: num(r.popularity ?? r.applePopularity),
    rank: num(r.rank ?? r.appStoreRank),
    volume: num(r.volume ?? r.searchVolume),
    difficulty: num(r.difficulty ?? r.keywordDifficulty ?? r.kd),
    maxReachChance: num(r.maxReachChance ?? r.reach),
    lastSeenAt: str(r.lastSeenAt ?? r.updatedAt),
  };
}

function mapRankingSample(r: Record<string, unknown>): AstroRankingSample {
  // Astro's real shape (per `search_rankings` response):
  //   { app, currentRanking, previousRanking, difficulty, popularity,
  //     keyword, store, lastUpdate, history?: [{date, ranking}] }
  // `store` is the country code (lowercased, "us"). We expose it as
  // `country` for symmetry with the rest of our research interface.
  const historyRaw = r.history;
  let history: { date: string; ranking: number | null }[] | undefined;
  if (Array.isArray(historyRaw)) {
    history = historyRaw
      .map((h) => (h && typeof h === "object" ? (h as Record<string, unknown>) : null))
      .filter((h): h is Record<string, unknown> => h !== null)
      .map((h) => ({
        date: str(h.date ?? h.timestamp) ?? "",
        ranking: num(h.ranking ?? h.rank ?? h.position),
      }))
      .filter((h) => h.date.length > 0);
  }
  return {
    keyword: str(r.keyword) ?? "",
    country: str(r.store ?? r.country ?? r.storefront) ?? "",
    rank: num(r.currentRanking ?? r.rank ?? r.appStoreRank),
    previousRank: num(r.previousRanking ?? r.previousRank),
    popularity: num(r.popularity ?? r.applePopularity),
    volume: num(r.volume ?? r.searchVolume),
    maxVolume: num(r.maxVolume ?? r.maxSearchVolume),
    difficulty: num(r.difficulty ?? r.keywordDifficulty ?? r.kd),
    maxReachChance: num(r.maxReachChance ?? r.reach),
    capturedAt: str(r.lastUpdate ?? r.capturedAt ?? r.timestamp),
    ...(history && history.length > 0 && { history }),
  };
}

function mapSuggestion(r: Record<string, unknown>): AstroKeywordSuggestion {
  return {
    keyword: str(r.keyword) ?? "",
    country: str(r.country ?? r.storefront),
    popularity: num(r.popularity ?? r.applePopularity),
    volume: num(r.volume ?? r.searchVolume),
    difficulty: num(r.difficulty ?? r.keywordDifficulty ?? r.kd),
    maxReachChance: num(r.maxReachChance ?? r.reach),
    cluster: str(r.cluster ?? r.category ?? r.tag),
    reason: str(r.reason ?? r.rationale),
  };
}

function mapCompetitorKeyword(r: Record<string, unknown>): AstroCompetitorKeyword {
  // Astro's extract_competitors_keywords returns the term under `text`
  // and a popularity 0-100 score. No rank/competitorCount in the
  // response — they're nullable in our type.
  return {
    keyword: str(r.text ?? r.keyword) ?? "",
    popularity: num(r.popularity ?? r.applePopularity),
    rank: num(r.rank ?? r.currentRanking),
    competitorCount: num(r.competitorCount ?? r.competitors),
    source: str(r.source ?? r.from),
  };
}

function mapAddKeywordsPerResult(r: Record<string, unknown>): AstroAddKeywordsPerResult {
  return {
    keyword: str(r.keyword) ?? "",
    popularity: num(r.popularity ?? r.applePopularity),
    difficulty: num(r.difficulty ?? r.keywordDifficulty ?? r.kd),
    ranking: num(r.ranking ?? r.currentRanking ?? r.rank),
    skipped: r.skipped === true,
    error: str(r.error),
  };
}

function mapAddKeywordsResult(raw: unknown, attempted: string[]): AstroAddKeywordsResult {
  // Astro's actual response shape (per real Desktop):
  //   {
  //     added:   integer,
  //     failed:  integer,
  //     skipped: integer,
  //     total:   integer,
  //     results: [{ keyword, popularity, difficulty, ranking,
  //                 success: bool, skipped: bool }]
  //   }
  // We surface added + skipped here. The results array carries
  // per-keyword popularity/difficulty/ranking which we could feed
  // back into local KeywordSignal rows — left to a future enhancement.
  const rec = asRecord(raw);
  if (rec) {
    if ("__astroText" in rec) {
      // Pattern: "Added 12 keywords. Skipped 3 (duplicates: a, b, c)"
      const text = String(rec.__astroText);
      const addedMatch = /added\s+(\d+)/i.exec(text);
      const skippedMatch = /skipped\s+(\d+)/i.exec(text);
      const dupes = /(?:duplicates?|skipped):\s*([^.\n)]+)/i.exec(text);
      const skippedNames =
        dupes?.[1]
          ?.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0) ?? [];
      const added = addedMatch ? Number(addedMatch[1]) : attempted.length - skippedNames.length;
      const skipped = skippedMatch ? Number(skippedMatch[1]) : skippedNames.length;
      return {
        added: Number.isFinite(added) ? added : attempted.length,
        skipped: Number.isFinite(skipped) ? skipped : 0,
        skippedKeywords: skippedNames,
        results: [],
      };
    }
    const added = num(rec.added) ?? num(rec.addedCount) ?? attempted.length;
    // Parse Astro's results[] for per-keyword metrics + skipped names.
    let results: AstroAddKeywordsPerResult[] = [];
    if (Array.isArray(rec.results)) {
      results = (rec.results as unknown[])
        .map((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null))
        .filter((v): v is Record<string, unknown> => v !== null)
        .map(mapAddKeywordsPerResult)
        .filter((r) => r.keyword.length > 0);
    }
    let skippedKeywords = results.filter((r) => r.skipped).map((r) => r.keyword);
    if (skippedKeywords.length === 0 && Array.isArray(rec.skippedKeywords)) {
      skippedKeywords = (rec.skippedKeywords as unknown[])
        .map((v) => (typeof v === "string" ? v : null))
        .filter((v): v is string => v !== null);
    }
    const skipped = num(rec.skipped) ?? num(rec.skippedCount) ?? skippedKeywords.length;
    return { added, skipped, skippedKeywords, results };
  }
  return { added: attempted.length, skipped: 0, skippedKeywords: [], results: [] };
}

/** Parse Astro's rate-limit message and return how long to wait
 *  before retrying, in milliseconds. Returns 0 when the error is NOT
 *  a rate-limit hint.
 *
 *  Message we've observed in the wild:
 *    "Server is temporarily busy (rate limit: 30 requests/min).
 *     Please wait 1 minute and retry."
 *
 *  We bias the wait UP slightly so the next attempt lands AFTER the
 *  server's window resets, not exactly on it. */
function parseRateLimitWaitMs(message: string): number {
  if (!/rate limit/i.test(message)) return 0;
  const m = /wait\s+(\d+)\s+(second|minute|hour)/i.exec(message);
  if (!m) return 5_000; // unknown wait → 5s default
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase() ?? "second";
  const ms = unit.startsWith("minute")
    ? n * 60_000
    : unit.startsWith("hour")
      ? n * 3_600_000
      : n * 1_000;
  return ms + 2_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
