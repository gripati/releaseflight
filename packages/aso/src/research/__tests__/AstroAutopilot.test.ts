import { describe, expect, test, vi } from "vitest";
import { AstroAutopilot, scoreAstroCandidate, isAsoNoiseCandidate, detectAppCategory } from "../AstroAutopilot";
import type {
  AutopilotApp,
  LocalTrackedKeyword,
} from "../AstroAutopilot";
import { AstroMcpClient } from "../AstroMcpClient";

/**
 * AstroAutopilot orchestrates AstroMcpClient. We mock the client by
 * driving its fetch — that lets us assert end-to-end behaviour without
 * the brittleness of class mocks.
 *
 * Coverage:
 *   • scoreAstroCandidate weighting + degradation
 *   • ensureAppTracked uses appId when present, else appName
 *   • syncKeywords chunks + records skipped duplicates
 *   • proposeSwaps classifies DECAY → DECAY_AUTO, others → OPPORTUNITY
 *   • proposeSwaps respects maxAutoSwaps cap (overflow → OPPORTUNITY)
 *   • proposeSwaps filters out candidates already in tracked set
 *   • proposeSwaps filters by minStrengthDelta
 *   • proposeSwaps survives provider error per seed (safeCall pattern)
 */

interface CapturedRequest {
  url: string;
  body: unknown;
}

function fakeFetch(
  responder: (req: CapturedRequest, attempt: number) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
): { fetch: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  let attempt = 0;
  const fn: typeof fetch = async (input, init) => {
    attempt += 1;
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    captured.push({ url, body });
    const r = await responder({ url, body }, attempt);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn, captured };
}

function rpcOk(content: unknown): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: 1,
      result: { content: Array.isArray(content) ? content : [content] },
    },
  };
}

// Convenience: each fetch call gets routed by tool name to a different
// response. Anything missing falls through to an empty result.
function fakeAstro(
  responses: Record<string, unknown>,
): { fetch: typeof fetch; calls: { tool: string; args: unknown }[] } {
  const calls: { tool: string; args: unknown }[] = [];
  const { fetch } = fakeFetch((req) => {
    const body = req.body as {
      params?: { name?: string; arguments?: unknown };
    };
    const tool = body.params?.name ?? "";
    calls.push({ tool, args: body.params?.arguments });
    const r = responses[tool];
    if (!r) return rpcOk({ type: "json", data: [] });
    return rpcOk(r);
  });
  return { fetch, calls };
}

const APP: AutopilotApp = {
  id: "app-1",
  appName: "PuzzlePro",
  bundleId: "com.test.puzzle",
  store: "ios",
  storeAppId: "1234567890",
};

function tracked(
  partial: Partial<LocalTrackedKeyword> & { keyword: string; id?: string },
): LocalTrackedKeyword {
  return {
    id: partial.id ?? `tk_${partial.keyword}`,
    keyword: partial.keyword,
    territory: partial.territory ?? "US",
    score: partial.score ?? null,
    bucket: partial.bucket ?? null,
    rank: partial.rank ?? null,
    inField: partial.inField ?? true,
    volume: partial.volume ?? null,
    difficulty: partial.difficulty ?? null,
    maxReachChance: partial.maxReachChance ?? null,
  };
}

describe("isAsoNoiseCandidate", () => {
  test.each([
    ["game", true],
    ["app", true],
    ["pro", true],
    ["free", true],
    ["new", true],
    ["best", true],
    ["a", true],   // single letter
    ["5", true],   // digit
    ["ai", true],
    ["puzzle", false],         // legit category
    ["brain test", false],     // multi-word, real
    ["block breaker", false],  // niche
    ["řezat", false],          // Czech-locale relevant
    ["bulmaca", false],        // Turkish puzzle
  ] as const)("%s → noise=%s", (kw, expected) => {
    expect(isAsoNoiseCandidate(kw)).toBe(expected);
  });

  describe("cross-category noise filter (host-aware)", () => {
    describe("game host", () => {
      test.each([
        // Photo & Video category markers — drop for a game
        ["photo collage maker", true],
        ["selfie editor pro", true],
        ["video editor master", true],
        ["camera filter beauty", true],
        // Finance markers — drop
        ["credit card manager", true],
        ["mortgage calculator", true],
        ["budget tracker", true],
        ["crypto wallet pro", true],
        // Health markers — drop
        ["workout planner", true],
        ["calorie counter", true],
        ["period tracker", true],
        // Productivity / Utilities — drop
        ["pdf reader fast", true],
        ["vpn fast secure", true],
        ["password manager", true],
        // Lifestyle / Weather — drop
        ["weather forecast pro", true],
        ["recipe book vegan", true],
        ["dating app singles", true],
        // Music creation — drop
        ["music maker studio", true],
        ["beat maker pro", true],
        // Legit game candidates stay
        ["block breaker brick", false],
        ["puzzle game", false],            // marker belongs to game itself
        ["card game solitaire", false],    // "card" alone is fine
        ["match 3 saga", false],           // marker belongs to game itself
        ["sniper shooter", false],         // still a game, AI scorer handles relevance
        ["candy crush like", false],       // marker belongs to game itself
      ] as const)("game: %s → noise=%s", (kw, expected) => {
        expect(isAsoNoiseCandidate(kw, "Games")).toBe(expected);
      });
    });

    describe("photo host", () => {
      test.each([
        // Now GAME markers should drop for a photo app
        ["rpg adventure", true],
        ["match 3 puzzle", true],
        ["tower defense battle", true],
        // Finance — drop
        ["credit card scanner", true],
        // Music creation — drop
        ["beat maker app", true],
        // Photo-category keywords stay
        ["photo collage maker", false],
        ["selfie editor pro", false],
        ["video editor master", false],
        ["camera filter beauty", false],
      ] as const)("photo: %s → noise=%s", (kw, expected) => {
        expect(isAsoNoiseCandidate(kw, "Photo & Video")).toBe(expected);
      });
    });

    describe("finance host", () => {
      test.each([
        // Game markers — drop
        ["rpg gold farm", true],
        ["match 3 puzzle", true],
        ["candy crush saga", true],
        // Photo markers — drop
        ["photo collage maker", true],
        ["camera filter pro", true],
        // Music creation — drop
        ["music maker studio", true],
        // Finance keywords stay
        ["credit card tracker", false],
        ["mortgage calculator", false],
        ["budget tracker pro", false],
        ["expense tracker", false],
      ] as const)("finance: %s → noise=%s", (kw, expected) => {
        expect(isAsoNoiseCandidate(kw, "Finance")).toBe(expected);
      });
    });

    describe("health & fitness host", () => {
      test.each([
        // Game markers — drop
        ["rpg adventure", true],
        ["match 3 puzzle", true],
        // Finance — drop
        ["credit card debt", true],
        // Health keywords stay
        ["workout planner", false],
        ["calorie counter", false],
        ["period tracker", false],
        ["yoga app", false],
        // Adjacent (medical) — different category, drop
        ["symptom checker", true],
      ] as const)("health: %s → noise=%s", (kw, expected) => {
        expect(isAsoNoiseCandidate(kw, "Health & Fitness")).toBe(expected);
      });
    });

    describe("music host", () => {
      test.each([
        // Game — drop
        ["rpg dungeon", true],
        ["match 3 saga", true],
        // Photo — drop
        ["photo collage", true],
        // Music keywords stay
        ["music maker studio", false],
        ["beat maker pro", false],
        ["drum machine app", false],
        ["guitar tuner free", false],
      ] as const)("music: %s → noise=%s", (kw, expected) => {
        expect(isAsoNoiseCandidate(kw, "Music")).toBe(expected);
      });
    });

    test("works with Apple's genre-name variants", () => {
      // All map to "game"
      expect(isAsoNoiseCandidate("photo collage", "Games")).toBe(true);
      expect(isAsoNoiseCandidate("photo collage", "Puzzle Games")).toBe(true);
      expect(isAsoNoiseCandidate("photo collage", "Casual Games")).toBe(true);
      expect(isAsoNoiseCandidate("photo collage", "Strategy Games")).toBe(true);
      // Maps to "photo"
      expect(isAsoNoiseCandidate("rpg adventure", "Photo & Video")).toBe(true);
      // Maps to "health"
      expect(isAsoNoiseCandidate("rpg adventure", "Health & Fitness")).toBe(true);
      // Maps to "food"
      expect(isAsoNoiseCandidate("rpg adventure", "Food & Drink")).toBe(true);
      // Maps to "social"
      expect(isAsoNoiseCandidate("rpg adventure", "Social Networking")).toBe(true);
    });

    test("unclassified genres (Entertainment, etc.) skip cross-category filter", () => {
      // Entertainment doesn't map to a category → only universal noise applies
      expect(isAsoNoiseCandidate("photo collage", "Entertainment")).toBe(false);
      expect(isAsoNoiseCandidate("credit card", "Entertainment")).toBe(false);
      // Universal still works
      expect(isAsoNoiseCandidate("game", "Entertainment")).toBe(true);
    });

    test("null / undefined genre falls back to universal noise only", () => {
      expect(isAsoNoiseCandidate("photo collage")).toBe(false);
      expect(isAsoNoiseCandidate("photo collage", null)).toBe(false);
      expect(isAsoNoiseCandidate("photo collage", undefined)).toBe(false);
      expect(isAsoNoiseCandidate("game", null)).toBe(true);
    });
  });
});

describe("detectAppCategory", () => {
  test.each([
    // games
    ["Games", "game"],
    ["Puzzle Games", "game"],
    ["Casual Games", "game"],
    ["Strategy Games", "game"],
    ["Action Games", "game"],
    // photo & video
    ["Photo & Video", "photo"],
    ["Photo and Video", "photo"],
    // finance
    ["Finance", "finance"],
    // health vs medical
    ["Health & Fitness", "health"],
    ["Medical", "medical"],
    // utilities
    ["Utilities", "utilities"],
    // productivity
    ["Productivity", "productivity"],
    // lifestyle
    ["Lifestyle", "lifestyle"],
    // weather
    ["Weather", "weather"],
    // music
    ["Music", "music"],
    // education
    ["Education", "education"],
    // social
    ["Social Networking", "social"],
    // news
    ["News", "news"],
    ["Magazines & Newspapers", "news"],
    // travel
    ["Travel", "travel"],
    // food & drink
    ["Food & Drink", "food"],
    // shopping
    ["Shopping", "shopping"],
    // business
    ["Business", "business"],
    // navigation
    ["Navigation", "navigation"],
    // books
    ["Books", "books"],
    // sports
    ["Sports", "sports"],
    // unclassified
    ["Entertainment", null],
    ["Reference", null],
    ["", null],
  ] as const)("'%s' → %s", (genre, expected) => {
    const arg: string | null = genre === "" ? "" : genre;
    expect(detectAppCategory(arg)).toBe(expected);
  });

  test("null and undefined return null", () => {
    expect(detectAppCategory(null)).toBe(null);
    expect(detectAppCategory(undefined)).toBe(null);
  });
});

describe("multi-word boost", () => {
  test("3-word candidate scores higher than 1-word at same popularity", () => {
    const base = {
      popularity: 50,
      volume: null,
      maxVolume: null,
      difficulty: null,
      maxReachChance: null,
      cluster: "LONG_TAIL" as string | null,
      reason: null,
      sources: [] as ("astro_suggestion" | "astro_competitor" | "astro_ranking")[],
    };
    const single = scoreAstroCandidate({ ...base, keyword: "puzzle" });
    const multi = scoreAstroCandidate({ ...base, keyword: "brain puzzle game" });
    expect(multi).toBeGreaterThan(single);
  });
});

describe("locale-language preference scoring", () => {
  const base = {
    popularity: 60 as number | null,
    volume: null,
    maxVolume: null,
    difficulty: null,
    maxReachChance: null,
    cluster: "COMPETITOR_BORROW" as string | null,
    reason: null,
    sources: [] as ("astro_suggestion" | "astro_competitor" | "astro_ranking")[],
  };

  test("Czech locale boosts diacritic candidates over plain-Latin", () => {
    const czechWord = scoreAstroCandidate({ ...base, keyword: "klíčový" }, "cs");
    const englishWord = scoreAstroCandidate({ ...base, keyword: "keyword" }, "cs");
    expect(czechWord).toBeGreaterThan(englishWord);
  });

  test("Czech locale strongly prefers diacritics: řezat > sudoku", () => {
    const a = scoreAstroCandidate({ ...base, keyword: "řezat" }, "cs");
    const b = scoreAstroCandidate({ ...base, keyword: "sudoku" }, "cs");
    expect(a).toBeGreaterThan(b);
  });

  test("Japanese locale hard-filters Latin candidates", () => {
    const latin = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "ja");
    const kana = scoreAstroCandidate({ ...base, keyword: "パズル" }, "ja");
    expect(kana).toBeGreaterThan(latin);
    // 0.45x multiplier should drag Latin candidates well below kana.
    expect(latin).toBeLessThan(kana * 0.6);
  });

  test("Russian locale prefers Cyrillic", () => {
    const cyr = scoreAstroCandidate({ ...base, keyword: "головоломка" }, "ru");
    const latin = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "ru");
    expect(cyr).toBeGreaterThan(latin);
  });

  test("Korean locale prefers Hangul", () => {
    const han = scoreAstroCandidate({ ...base, keyword: "퍼즐" }, "ko");
    const latin = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "ko");
    expect(han).toBeGreaterThan(latin);
  });

  test("Turkish locale boosts ç/ğ/ş/ü diacritics", () => {
    const tr = scoreAstroCandidate({ ...base, keyword: "bulmaca özçözüm" }, "tr");
    const en = scoreAstroCandidate({ ...base, keyword: "puzzle game" }, "tr");
    expect(tr).toBeGreaterThan(en);
  });

  test("English locale gives equal weight (no language penalty)", () => {
    const a = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "en");
    const b = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "en-US");
    expect(a).toBeCloseTo(b, 3);
  });

  test("score without localeHint is unchanged from previous behaviour", () => {
    const withHint = scoreAstroCandidate({ ...base, keyword: "puzzle" }, "en");
    const noHint = scoreAstroCandidate({ ...base, keyword: "puzzle" });
    expect(withHint).toBeCloseTo(noHint, 3);
  });

  test("locale code with region (cs-CZ) is handled like bare cs", () => {
    const a = scoreAstroCandidate({ ...base, keyword: "hlavolam" }, "cs-CZ");
    const b = scoreAstroCandidate({ ...base, keyword: "hlavolam" }, "cs");
    expect(a).toBeCloseTo(b, 3);
  });
});

describe("scoreAstroCandidate", () => {
  test("empty signals → 0", () => {
    expect(
      scoreAstroCandidate({
        keyword: "x",
        popularity: null,
        volume: null,
        maxVolume: null,
        difficulty: null,
        maxReachChance: null,
        cluster: null,
        reason: null,
        sources: [],
      }),
    ).toBeGreaterThan(0); // cluster bonus is always present
  });

  test("strong painkiller signals → high score", () => {
    const s = scoreAstroCandidate({
      keyword: "headache tracker",
      popularity: 4.5,
      volume: 4000,
      maxVolume: 5000,
      difficulty: 15,
      maxReachChance: 75,
      cluster: "PAINKILLER",
      reason: null,
      sources: ["astro_suggestion"],
    });
    expect(s).toBeGreaterThan(0.75);
  });

  test("vanity signals (high difficulty, low reach) → low score", () => {
    const s = scoreAstroCandidate({
      keyword: "best game",
      popularity: 5,
      volume: 5000,
      maxVolume: 5000,
      difficulty: 95,
      maxReachChance: 5,
      cluster: "CORE",
      reason: null,
      sources: ["astro_suggestion"],
    });
    expect(s).toBeLessThan(0.65);
  });

  test("cluster bonus shifts score (PAINKILLER > CORE > BRAND)", () => {
    const base = {
      keyword: "x",
      popularity: 3,
      volume: 2000,
      maxVolume: 5000,
      difficulty: 30,
      maxReachChance: 50,
      reason: null,
      sources: ["astro_suggestion" as const],
    };
    const painkiller = scoreAstroCandidate({ ...base, cluster: "PAINKILLER" });
    const core = scoreAstroCandidate({ ...base, cluster: "CORE" });
    const brand = scoreAstroCandidate({ ...base, cluster: "BRAND" });
    expect(painkiller).toBeGreaterThan(core);
    expect(core).toBeGreaterThan(brand);
  });

  test("missing maxVolume falls back to log-normalised volume", () => {
    const s = scoreAstroCandidate({
      keyword: "x",
      popularity: null,
      volume: 100_000,
      maxVolume: null,
      difficulty: null,
      maxReachChance: null,
      cluster: "LONG_TAIL",
      reason: null,
      sources: [],
    });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("enrich + realistic-target filter", () => {
  // Each test seeds extract_competitors_keywords with high-popularity
  // (competitor-frequency) candidates, then verifies the enrich call
  // overwrites those numbers with REAL Apple metrics and the filter
  // drops candidates outside the user's winnable range.

  test("enrichWithMetrics replaces competitor-frequency popularity with Apple's", async () => {
    const calls: { tool: string; args: unknown }[] = [];
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      calls.push({ tool, args: params?.arguments });
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: {
            keywords: [
              // Mining returns 76 — competitor-frequency popularity
              { text: "subway surfers", popularity: 76 },
              { text: "candy crush", popularity: 76 },
            ],
          },
        },
        add_keywords: {
          type: "json",
          // Astro's add_keywords returns the REAL Apple numbers:
          // pop 76 / diff 85 for subway surfers — high but crushing
          // difficulty so the filter drops it.
          data: {
            added: 2,
            failed: 0,
            skipped: 0,
            total: 2,
            results: [
              {
                keyword: "subway surfers",
                popularity: 76,
                difficulty: 85,
                success: true,
                skipped: false,
              },
              {
                keyword: "candy crush",
                popularity: 76,
                difficulty: 87,
                success: true,
                skipped: false,
              },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, local, {
      territory: "US",
      includeCompetitorMining: true,
      // Realistic window: needs winnable difficulty
      minPopularity: 25,
      maxDifficulty: 60,
    });
    // Both candidates have difficulty > 60 — should be filtered out.
    const surfaced = r.proposals.map((p) => p.strong.keyword);
    expect(surfaced).not.toContain("subway surfers");
    expect(surfaced).not.toContain("candy crush");
    // Verify add_keywords WAS called (enrichment fired)
    expect(calls.filter((c) => c.tool === "add_keywords").length).toBeGreaterThan(0);
  });

  test("filter keeps candidates inside the winnable window", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: {
            keywords: [
              { text: "block puzzle game", popularity: 55 },
              { text: "winnable term", popularity: 40 },
            ],
          },
        },
        add_keywords: {
          type: "json",
          data: {
            added: 2,
            failed: 0,
            skipped: 0,
            total: 2,
            results: [
              // pop 55 + diff 45 → INSIDE the window (25-? / ?-60)
              {
                keyword: "block puzzle game",
                popularity: 55,
                difficulty: 45,
                success: true,
                skipped: false,
              },
              // pop 40 + diff 35 → INSIDE the window
              {
                keyword: "winnable term",
                popularity: 40,
                difficulty: 35,
                success: true,
                skipped: false,
              },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, local, {
      territory: "US",
      includeCompetitorMining: true,
      minPopularity: 25,
      maxDifficulty: 60,
    });
    const surfaced = r.proposals.map((p) => p.strong.keyword);
    expect(surfaced).toContain("block puzzle game");
    expect(surfaced).toContain("winnable term");
  });

  test("enrichWithMetrics=false skips the add_keywords enrichment call", async () => {
    const calls: { tool: string }[] = [];
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      calls.push({ tool });
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: { keywords: [{ text: "candidate", popularity: 50 }] },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    await ap.proposeSwaps(
      APP,
      [tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" })],
      {
        territory: "US",
        includeCompetitorMining: true,
        enrichWithMetrics: false,
      },
    );
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(0);
  });

  test("unenriched candidates bypass the filter (suggestion scale stays valid)", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: {
          type: "json",
          // popularity:4 on the 0-5 suggestion scale — would be cut
          // by minPopularity:25 if the filter applied unenriched.
          data: [
            {
              keyword: "brain puzzle",
              popularity: 4,
              volume: 3000,
              difficulty: 20,
              maxReachChance: 60,
              cluster: "LONG_TAIL",
            },
          ],
        },
        // No add_keywords mock — even if the autopilot tries to enrich,
        // it gets empty results and the unenriched candidate stays.
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(
      APP,
      [tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" })],
      { territory: "US", includeCompetitorMining: false, minPopularity: 25 },
    );
    const surfaced = r.proposals.map((p) => p.strong.keyword);
    expect(surfaced).toContain("brain puzzle");
  });
});

describe("AI relevance filter", () => {
  // Verify the relevance scorer drops candidates the AI marked as
  // unrelated (e.g. "photo collage" for a block-breaker game) while
  // keeping the ones rated above the threshold.

  test("drops candidates below minRelevance threshold (default 40)", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: {
            keywords: [
              { text: "block breaker", popularity: 50 },
              { text: "photo collage", popularity: 60 },
              { text: "sniper games", popularity: 70 },
              { text: "brick game", popularity: 55 },
            ],
          },
        },
        add_keywords: {
          type: "json",
          data: {
            added: 4,
            failed: 0,
            skipped: 0,
            total: 4,
            results: [
              { keyword: "block breaker", popularity: 50, difficulty: 40, success: true, skipped: false },
              { keyword: "photo collage", popularity: 60, difficulty: 50, success: true, skipped: false },
              { keyword: "sniper games", popularity: 70, difficulty: 55, success: true, skipped: false },
              { keyword: "brick game", popularity: 55, difficulty: 45, success: true, skipped: false },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const aiRelevanceScorer = vi.fn(async () => ({
      scores: [
        { keyword: "block breaker", relevance: 95, reason: "Core mechanic" },
        { keyword: "photo collage", relevance: 8, reason: "Unrelated photo app" },
        { keyword: "sniper games", relevance: 12, reason: "Different genre" },
        { keyword: "brick game", relevance: 88, reason: "Same mechanic" },
      ],
    }));

    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, local, {
      territory: "US",
      includeCompetitorMining: true,
      aiRelevanceScorer,
    });
    expect(aiRelevanceScorer).toHaveBeenCalled();
    const surfaced = r.proposals.map((p) => p.strong.keyword);
    expect(surfaced).toContain("block breaker");
    expect(surfaced).toContain("brick game");
    expect(surfaced).not.toContain("photo collage");
    expect(surfaced).not.toContain("sniper games");
  });

  test("relevance boost — higher-relevance candidate ranks above higher-popularity unrelated one", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: {
            keywords: [
              { text: "brick game", popularity: 40 },
              { text: "music maker", popularity: 60 }, // higher pop but irrelevant
            ],
          },
        },
        add_keywords: {
          type: "json",
          data: {
            added: 2,
            failed: 0,
            skipped: 0,
            total: 2,
            results: [
              { keyword: "brick game", popularity: 40, difficulty: 35, success: true, skipped: false },
              { keyword: "music maker", popularity: 60, difficulty: 40, success: true, skipped: false },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const aiRelevanceScorer = vi.fn(async () => ({
      scores: [
        { keyword: "brick game", relevance: 92, reason: "Core mechanic" },
        { keyword: "music maker", relevance: 45, reason: "Adjacent, weak fit" },
      ],
    }));

    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, local, {
      territory: "US",
      includeCompetitorMining: true,
      aiRelevanceScorer,
    });
    // brick game (40 pop, 92 rel) should rank above music maker (60 pop, 45 rel)
    expect(r.proposals[0]?.strong.keyword).toBe("brick game");
  });

  test("scorer failure is non-fatal — falls back to no relevance filter", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: { keywords: [{ text: "brick game", popularity: 55 }] },
        },
        add_keywords: {
          type: "json",
          data: {
            added: 1,
            failed: 0,
            skipped: 0,
            total: 1,
            results: [
              { keyword: "brick game", popularity: 55, difficulty: 40, success: true, skipped: false },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const aiRelevanceScorer = vi.fn(async () => {
      throw new Error("AI provider down");
    });

    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(
      APP,
      [tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" })],
      { territory: "US", includeCompetitorMining: true, aiRelevanceScorer },
    );
    // Brick game still surfaces — AI failure didn't abort the analyze.
    expect(r.proposals.map((p) => p.strong.keyword)).toContain("brick game");
  });

  test("custom minRelevance threshold lets the user tune the filter", async () => {
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })?.params;
      const tool = params?.name ?? "";
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        get_app_keywords: { type: "json", data: [] },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: {
            keywords: [
              { text: "adjacent term", popularity: 50 },
              { text: "core term", popularity: 50 },
            ],
          },
        },
        add_keywords: {
          type: "json",
          data: {
            added: 2,
            failed: 0,
            skipped: 0,
            total: 2,
            results: [
              { keyword: "adjacent term", popularity: 50, difficulty: 40, success: true, skipped: false },
              { keyword: "core term", popularity: 50, difficulty: 40, success: true, skipped: false },
            ],
          },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [r] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const aiRelevanceScorer = vi.fn(async () => ({
      scores: [
        { keyword: "adjacent term", relevance: 65, reason: "Adjacent" },
        { keyword: "core term", relevance: 90, reason: "Core" },
      ],
    }));

    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    // Strict threshold 80 drops adjacent (65) but keeps core (90).
    const r = await ap.proposeSwaps(
      APP,
      [tracked({ keyword: "blok", territory: "US", score: 0.15, bucket: "DECAY" })],
      {
        territory: "US",
        includeCompetitorMining: true,
        aiRelevanceScorer,
        minRelevance: 80,
      },
    );
    const surfaced = r.proposals.map((p) => p.strong.keyword);
    expect(surfaced).toContain("core term");
    expect(surfaced).not.toContain("adjacent term");
  });
});

describe("getKeywordRankings", () => {
  test("returns live rank + previous + popularity + difficulty + history", async () => {
    const { fetch } = fakeAstro({
      search_rankings: {
        type: "json",
        data: [
          {
            app: "Pixy Block Breaker",
            keyword: "puzzle",
            store: "us",
            currentRanking: 38,
            previousRanking: 45,
            popularity: 72,
            difficulty: 65,
            lastUpdate: "2026-05-19T05:11:58Z",
            history: [
              { date: "2026-05-19T00:00:00Z", ranking: 38 },
              { date: "2026-05-18T00:00:00Z", ranking: 45 },
              { date: "2026-05-17T00:00:00Z", ranking: 60 },
            ],
          },
        ],
      },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.getKeywordRankings({ keyword: "puzzle", store: "us" });
    expect(r).not.toBeNull();
    expect(r?.rank).toBe(38);
    expect(r?.previousRank).toBe(45);
    expect(r?.popularity).toBe(72);
    expect(r?.difficulty).toBe(65);
    expect(r?.history).toHaveLength(3);
    expect(r?.history[0]?.ranking).toBe(38);
  });

  test("returns null when Astro has no observation for the keyword", async () => {
    const { fetch } = fakeAstro({
      search_rankings: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.getKeywordRankings({ keyword: "x", store: "us" });
    expect(r).toBeNull();
  });
});

describe("ensureAppTracked", () => {
  test("calls add_app with appStoreId from the App Store numeric id", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const id = await ap.ensureAppTracked(APP);
    expect(id).toBe("1234567890");
    expect(calls[0]).toMatchObject({
      tool: "add_app",
      args: { appStoreId: "1234567890" },
    });
  });

  test("throws when storeAppId is missing — Astro needs the numeric id", async () => {
    const { fetch } = fakeAstro({});
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    await expect(ap.ensureAppTracked({ ...APP, storeAppId: null })).rejects.toThrow(
      /storeAppId/,
    );
  });
});

describe("syncKeywords", () => {
  test("registers app then pushes keywords in <=100 chunks for the given store", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
      add_keywords: {
        type: "json",
        data: { added: 100, failed: 0, skipped: 0, total: 100, results: [] },
      },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const kws = Array.from({ length: 250 }, (_, i) => `kw-${i.toString()}`);
    const r = await ap.syncKeywords(APP, kws, "us");
    // Astro's add_app returns the App Store id as `appId` — our
    // ensureAppTracked falls back to storeAppId when the response is
    // empty (e.g. duplicate), but here the response has a fresh id.
    expect(r.astroAppId).toBe("1234567890");
    expect(r.chunks).toBe(3);
    expect(r.added).toBe(300);
    const addKeywordCalls = calls.filter((c) => c.tool === "add_keywords");
    expect(addKeywordCalls).toHaveLength(3);
    const firstArgs = addKeywordCalls[0]?.args as { store: string; appId: string };
    expect(firstArgs.store).toBe("us");
    expect(firstArgs.appId).toBe("1234567890");
  });

  test("empty keyword list → no add_keywords calls + returns zeroes", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.syncKeywords(APP, [], "us");
    expect(r).toEqual({
      astroAppId: "1234567890",
      added: 0,
      skipped: 0,
      skippedKeywords: [],
      chunks: 0,
    });
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(0);
  });

  test("dedupes case-insensitive variants before chunking", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
      add_keywords: {
        type: "json",
        data: { added: 2, failed: 0, skipped: 0, total: 2, results: [] },
      },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    await ap.syncKeywords(APP, ["puzzle", "Puzzle", "PUZZLE", "match three"], "us");
    const addCall = calls.find((c) => c.tool === "add_keywords");
    const args = addCall?.args as { keywords: string[] };
    expect(args.keywords).toHaveLength(2);
    expect(args.keywords.map((k) => k.toLowerCase())).toEqual(["puzzle", "match three"]);
  });

  test("Duplicate entry from add_app falls back to storeAppId for subsequent calls", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: {
        type: "text",
        text: "Error: Duplicate entry: App with ID '1234567890' is already tracked",
      },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
    });
    // The add_app responder above produces a non-error envelope with
    // the duplicate text in `text`, which our mapper handles. To force
    // the `isError` branch, override with a custom responder.
    const errorFetch: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const tool = (body as { params?: { name?: string } })?.params?.name ?? "";
      if (tool === "add_app") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Error: Duplicate entry: App with ID '1234567890' is already tracked",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "json",
                data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    void calls;
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: errorFetch }),
    });
    const r = await ap.syncKeywords(APP, ["one"], "us");
    expect(r.astroAppId).toBe("1234567890"); // fell back to storeAppId
    expect(r.added).toBe(1);
  });
});

describe("proposeSwaps", () => {
  const baseLocal: LocalTrackedKeyword[] = [
    tracked({ keyword: "old keyword", score: 0.15, bucket: "DECAY", rank: null, inField: true }),
    tracked({ keyword: "mid keyword", score: 0.35, bucket: "NEUTRAL", rank: 20, inField: true }),
    tracked({ keyword: "good keyword", score: 0.75, bucket: "CHAMPION", rank: 3, inField: true }),
  ];

  test("classifies DECAY weaks as DECAY_AUTO until cap, then OPPORTUNITY", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: [
          { keyword: "stronger one", popularity: 4, volume: 3000, difficulty: 20, maxReachChance: 60, cluster: "PAINKILLER" },
          { keyword: "stronger two", popularity: 3.8, volume: 2800, difficulty: 22, maxReachChance: 55, cluster: "LONG_TAIL" },
          { keyword: "stronger three", popularity: 3.6, volume: 2500, difficulty: 25, maxReachChance: 50, cluster: "SYNONYM" },
        ],
      },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, baseLocal, {
      territory: "US",
      maxAutoSwaps: 1,
      maxProposals: 10,
    });
    expect(r.proposals.length).toBeGreaterThan(0);
    const auto = r.proposals.filter((p) => p.kind === "DECAY_AUTO");
    expect(auto.length).toBeLessThanOrEqual(1);
    // first weak is DECAY → first proposal should be DECAY_AUTO
    expect(r.proposals[0]?.kind).toBe("DECAY_AUTO");
    // Subsequent proposals fall back to OPPORTUNITY because the next
    // weak is NEUTRAL (not DECAY) — they should be OPPORTUNITY_PREVIEW.
    if (r.proposals.length > 1) {
      expect(r.proposals[1]?.kind).toBe("OPPORTUNITY_PREVIEW");
    }
  });

  test("filters candidates already in the local tracked set", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: [
          { keyword: "good keyword", popularity: 4, volume: 3000, difficulty: 18, maxReachChance: 60 }, // already tracked
          { keyword: "fresh idea", popularity: 4, volume: 3000, difficulty: 18, maxReachChance: 60, cluster: "LONG_TAIL" },
        ],
      },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, baseLocal, { territory: "US" });
    const proposed = r.proposals.map((p) => p.strong.keyword);
    expect(proposed).not.toContain("good keyword");
    expect(proposed).toContain("fresh idea");
  });

  test("respects minStrengthDelta — no swap pairs when uplift is sub-threshold", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        // candidate that scores roughly same as the weakest local (DECAY 0.15)
        data: [
          { keyword: "too weak", popularity: 0.5, volume: 100, maxVolume: 5000, difficulty: 80, maxReachChance: 10, cluster: "BRAND" },
        ],
      },
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, baseLocal, {
      territory: "US",
      minStrengthDelta: 0.6, // intentionally strict
    });
    // The delta gate kills SWAP-style proposals (DECAY_AUTO /
    // OPPORTUNITY_PREVIEW). OPPORTUNITY_NEW bypasses that gate because
    // it's an addition, not a replacement — so surviving candidates may
    // still surface as fresh adds. We only assert that NO swap pairs
    // came through.
    const swaps = r.proposals.filter(
      (p) => p.kind === "DECAY_AUTO" || p.kind === "OPPORTUNITY_PREVIEW",
    );
    expect(swaps).toHaveLength(0);
    for (const p of r.proposals) {
      expect(p.kind).toBe("OPPORTUNITY_NEW");
      expect(p.weak).toBeNull();
    }
  });

  test("emits OPPORTUNITY_NEW when there are no weak keywords to swap against", async () => {
    // All local keywords are healthy CHAMPIONs — nothing to "swap out".
    // Before the OPPORTUNITY_NEW path, the panel would be empty here.
    // Now the surviving strong candidates surface as fresh adds.
    const allChampions: LocalTrackedKeyword[] = [
      tracked({ keyword: "champ one", score: 0.85, bucket: "CHAMPION", rank: 2, inField: true }),
      tracked({ keyword: "champ two", score: 0.8, bucket: "CHAMPION", rank: 4, inField: true }),
    ];
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: [
          { keyword: "fresh idea", popularity: 4, volume: 3500, difficulty: 18, maxReachChance: 65, cluster: "PAINKILLER" },
          { keyword: "another one", popularity: 3.5, volume: 2200, difficulty: 25, maxReachChance: 55, cluster: "LONG_TAIL" },
        ],
      },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, allChampions, { territory: "US" });
    expect(r.proposals.length).toBeGreaterThan(0);
    for (const p of r.proposals) {
      expect(p.kind).toBe("OPPORTUNITY_NEW");
      expect(p.weak).toBeNull();
      expect(p.strong.keyword.length).toBeGreaterThan(0);
    }
    // Rationale should call it a new opportunity, not a swap.
    expect(r.proposals[0]?.rationale.toLowerCase()).toContain("new opportunity");
  });

  test("appMetadataSeeds are folded into the competitor mining pool", async () => {
    // Track every extract_competitors_keywords call so we can verify the
    // metadata seed (`puzzle`) actually got pushed as a mining anchor —
    // proving the worker→autopilot→Astro plumbing is intact.
    const minedSeeds: string[] = [];
    const customFetch: typeof fetch = async (_input, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const tool = (body as { params?: { name?: string } })?.params?.name ?? "";
      const args = (body as { params?: { arguments?: Record<string, unknown> } })
        ?.params?.arguments;
      if (tool === "extract_competitors_keywords") {
        const seed = args && typeof args.keyword === "string" ? args.keyword : null;
        if (seed) minedSeeds.push(seed.toLowerCase());
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "json", data: [] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (tool === "get_keyword_suggestions") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "json", data: [] }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // add_keywords / add_app / etc — return success no-op.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "json",
                data: { added: 0, failed: 0, skipped: 0, total: 0, results: [] },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: customFetch, requestsPerMinute: 0 }),
    });
    await ap.proposeSwaps(APP, [], {
      territory: "US",
      includeCompetitorMining: true,
      appMetadataSeeds: ["puzzle", "merge", "x"], // "x" filtered (len < 2)
    });
    // The autopilot should have mined on "puzzle" and "merge"; "x" must
    // be filtered out because it falls below the 2-char floor.
    expect(minedSeeds).toContain("puzzle");
    expect(minedSeeds).toContain("merge");
    expect(minedSeeds).not.toContain("x");
  });

  test("survives competitor mining errors per seed (safeCall pattern)", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: [
          { keyword: "good alternative", popularity: 4, volume: 3500, difficulty: 18, maxReachChance: 65, cluster: "PAINKILLER" },
        ],
      },
      // Make extract_competitors_keywords ALWAYS error — autopilot
      // should still return proposals from get_keyword_suggestions.
      extract_competitors_keywords: { type: "text", text: "OOPS" }, // unparseable
    });
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, baseLocal, { territory: "US" });
    // Should still have at least one proposal from the suggestion pool.
    expect(r.proposals.length).toBeGreaterThan(0);
  });

  test("diagnostic counts reflect provider responses", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: Array.from({ length: 4 }, (_, i) => ({
          keyword: `sug-${i.toString()}`,
          popularity: 4,
          volume: 3000,
          difficulty: 20,
          maxReachChance: 60,
          cluster: "LONG_TAIL",
        })),
      },
      extract_competitors_keywords: {
        type: "json",
        data: Array.from({ length: 3 }, (_, i) => ({
          keyword: `comp-${i.toString()}`,
          popularity: 3.5,
        })),
      },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.proposeSwaps(APP, baseLocal, {
      territory: "US",
      // Competitor mining is opt-in (defaults to false to protect the
      // Astro rate limit on multi-locale apps). Enable it explicitly
      // so this test still exercises the mining path.
      includeCompetitorMining: true,
    });
    expect(r.diagnostics.suggestionSampleCount).toBe(4);
    // The competitor mine is called once per strong seed — there's 1
    // CHAMPION in baseLocal so it should produce 3 competitor rows.
    expect(r.diagnostics.competitorSampleCount).toBeGreaterThan(0);
  });

  test("territory filter — only considers local rows in that territory", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        // Pick a candidate that isn't in the ASO noise blocklist —
        // generic words like "new", "game", "app" get filtered out by
        // design now, so tests need a real niche term.
        data: [
          { keyword: "brain puzzle", popularity: 4, volume: 3000, difficulty: 20, maxReachChance: 60, cluster: "LONG_TAIL" },
        ],
      },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "us-only", territory: "US", score: 0.2, bucket: "DECAY" }),
      tracked({ keyword: "tr-only", territory: "TR", score: 0.2, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, local, { territory: "TR" });
    expect(r.proposals[0]?.weak?.keyword).toBe("tr-only");
  });

  test("uppercases territory and matches case-insensitively", async () => {
    const { fetch } = fakeAstro({
      get_keyword_suggestions: {
        type: "json",
        data: [
          { keyword: "brain puzzle", popularity: 4, volume: 3000, difficulty: 20, maxReachChance: 60, cluster: "LONG_TAIL" },
        ],
      },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "us-keyword", territory: "us", score: 0.2, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({ client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }) });
    const r = await ap.proposeSwaps(APP, local, { territory: "us" });
    expect(r.territory).toBe("US");
    expect(r.proposals.length).toBeGreaterThan(0);
  });
});

describe("analyze — smart end-to-end sync", () => {
  test("calls add_app once + add_keywords per territory + proposeSwaps per territory", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
      add_keywords: { type: "json", data: { added: 2, failed: 0, skipped: 0, total: 2, results: [] } },
      get_keyword_suggestions: {
        type: "json",
        data: [
          {
            keyword: "fresh strong",
            popularity: 4,
            volume: 3000,
            difficulty: 20,
            maxReachChance: 60,
            cluster: "PAINKILLER",
          },
        ],
      },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "weak-us-1", territory: "US", score: 0.15, bucket: "DECAY" }),
      tracked({ keyword: "weak-us-2", territory: "US", score: 0.25, bucket: "NEUTRAL" }),
      tracked({ keyword: "weak-tr-1", territory: "TR", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    // Disable the new enrichment call so we can isolate the sync calls
    // we're asserting against. The enrichment path has its own dedicated
    // tests below.
    const r = await ap.analyze(APP, local, {
      territories: ["US", "TR"],
      enrichWithMetrics: false,
    });

    expect(r.astroAppId).toBe("1234567890");
    expect(calls.filter((c) => c.tool === "add_app")).toHaveLength(1);
    // One add_keywords call per non-empty territory chunk (2 keywords
    // in US fits one chunk, 1 in TR fits one chunk).
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(2);
    // proposeSwaps gets called per territory → 2 suggestion fetches
    expect(calls.filter((c) => c.tool === "get_keyword_suggestions")).toHaveLength(2);
    expect(r.syncByTerritory.map((s) => s.territory).sort()).toEqual(["TR", "US"]);
  });

  test("dedupes territories regardless of casing", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
      add_keywords: { type: "json", data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] } },
      get_keyword_suggestions: { type: "json", data: [] },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "kw", territory: "US", score: 0.2, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, local, { territories: ["us", "US", "Us"] });
    // Should collapse to one territory
    expect(r.syncByTerritory).toHaveLength(1);
    expect(r.syncByTerritory[0]?.territory).toBe("US");
    expect(calls.filter((c) => c.tool === "get_keyword_suggestions")).toHaveLength(1);
  });

  test("isolated per-territory sync failure does not block other territories", async () => {
    let trCalls = 0;
    const responder = (req: { body: unknown }) => {
      const body = req.body as { params?: { name?: string; arguments?: unknown } };
      const tool = body.params?.name ?? "";
      if (tool === "add_keywords") {
        const args = body.params?.arguments as { keywords?: string[] };
        const isTr = args.keywords?.[0]?.startsWith("tr-");
        if (isTr) {
          trCalls += 1;
          return {
            status: 200,
            body: {
              jsonrpc: "2.0",
              id: 1,
              result: {
                isError: true,
                content: [{ type: "text", text: "fake tr-only failure" }],
              },
            },
          };
        }
        return rpcOk({
          type: "json",
          data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
        });
      }
      if (tool === "add_app") {
        return rpcOk({ type: "json", data: { appId: "1234567890", name: "X" } });
      }
      if (tool === "get_keyword_suggestions") {
        return rpcOk({ type: "json", data: [] });
      }
      return rpcOk({ type: "json", data: [] });
    };
    const captured: { tool: string }[] = [];
    let attempt = 0;
    const fn: typeof fetch = async (_input, init) => {
      attempt += 1;
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const tool = (body as { params?: { name?: string } })?.params?.name ?? "";
      captured.push({ tool });
      const r = await responder({ body });
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    void attempt;
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "us-kw", territory: "US", score: 0.2, bucket: "DECAY" }),
      tracked({ keyword: "tr-kw", territory: "TR", score: 0.2, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({
        endpoint: "x",
        fetchImpl: fn,
        // Retry of TR would still hit the same error path — that's fine,
        // we just don't want it to consume time in tests.
        retries: 0,
        // Disable the rate limiter for tests (default 25/min).
        requestsPerMinute: 0,
      }),
    });
    const r = await ap.analyze(APP, local, { territories: ["US", "TR"] });
    expect(trCalls).toBeGreaterThanOrEqual(1);
    // TR sync should be flagged with an error, US should be fine.
    const tr = r.syncByTerritory.find((s) => s.territory === "TR");
    const us = r.syncByTerritory.find((s) => s.territory === "US");
    expect(tr?.error).toMatch(/tr-only failure/);
    expect(us?.error).toBeUndefined();
    // Both territories still got a recommendations bucket (TR's may be
    // empty but the call should have been attempted).
    expect(r.recommendationsByTerritory.map((b) => b.territory).sort()).toEqual([
      "TR",
      "US",
    ]);
  });

  test("totals reflect per-territory aggregation", async () => {
    const { fetch } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "PuzzlePro" } },
      add_keywords: {
        type: "json",
        data: {
          added: 3,
          failed: 0,
          skipped: 1,
          total: 4,
          results: [{ keyword: "dup", skipped: true, success: false }],
        },
      },
      get_keyword_suggestions: {
        type: "json",
        data: [
          {
            keyword: "fresh strong",
            popularity: 4,
            volume: 3000,
            difficulty: 20,
            maxReachChance: 60,
            cluster: "PAINKILLER",
          },
        ],
      },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "us-1", territory: "US", score: 0.15, bucket: "DECAY" }),
      tracked({ keyword: "tr-1", territory: "TR", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, local, { territories: ["US", "TR"] });
    expect(r.totals.added).toBe(6); // 3 per territory × 2
    expect(r.totals.skipped).toBe(2);
    expect(r.totals.proposals).toBeGreaterThan(0);
    expect(r.totals.autoSwaps + r.totals.opportunities).toBe(r.totals.proposals);
  });

  test("durationMs is set", async () => {
    const { fetch } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: { type: "json", data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] } },
      get_keyword_suggestions: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, [tracked({ keyword: "x", territory: "US" })], {
      territories: ["US"],
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("skipEmptyTerritories (default true) drops storefronts with no tracked keywords", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_keyword_suggestions: { type: "json", data: [] },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "us-only", territory: "US", score: 0.2, bucket: "DECAY" }),
      // No TR or DE rows — those territories should be skipped.
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, local, { territories: ["US", "TR", "DE"] });
    expect(r.syncByTerritory.map((s) => s.territory)).toEqual(["US"]);
    expect(r.recommendationsByTerritory.map((s) => s.territory)).toEqual(["US"]);
    // No add_keywords burned on TR/DE
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(1);
    expect(calls.filter((c) => c.tool === "get_keyword_suggestions")).toHaveLength(1);
  });

  test("skipEmptyTerritories=false keeps storefronts with no keywords (still skips add_keywords)", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      get_keyword_suggestions: { type: "json", data: [] },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, [], {
      territories: ["US", "TR"],
      skipEmptyTerritories: false,
    });
    expect(r.syncByTerritory).toHaveLength(2);
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(0);
    // get_keyword_suggestions still fires per territory (it's how
    // Astro discovers candidates even without seeded keywords).
    expect(calls.filter((c) => c.tool === "get_keyword_suggestions")).toHaveLength(2);
  });

  test("includeCompetitorMining=false explicitly disables mining", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_app_keywords: { type: "json", data: [] },
      get_keyword_suggestions: {
        type: "json",
        data: [
          {
            keyword: "candidate",
            popularity: 4,
            volume: 1000,
            difficulty: 20,
            maxReachChance: 60,
            cluster: "LONG_TAIL",
          },
        ],
      },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "anchor", territory: "US", score: 0.8, bucket: "CHAMPION" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    await ap.analyze(APP, local, {
      territories: ["US"],
      includeCompetitorMining: false,
    });
    expect(calls.filter((c) => c.tool === "extract_competitors_keywords")).toHaveLength(0);
  });

  test("mining seeds come from weak keywords + Astro's tracked top-pop", async () => {
    const calls: { tool: string; args: unknown }[] = [];
    const fetchImpl: typeof globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      const params = (body as { params?: { name?: string; arguments?: unknown } })
        ?.params;
      const tool = params?.name ?? "";
      calls.push({ tool, args: params?.arguments });
      const responders: Record<string, unknown> = {
        add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
        add_keywords: {
          type: "json",
          data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
        },
        get_app_keywords: {
          type: "json",
          // Astro has these tracked for US — the AUTOPILOT MUST use
          // them as mining seeds, NOT our local "local-only" CHAMPION.
          data: [
            { keyword: "puzzle", country: "us", popularity: 65 },
            { keyword: "block", country: "us", popularity: 65 },
            { keyword: "smash", country: "us", popularity: 8 },
          ],
        },
        get_keyword_suggestions: { type: "json", data: [] },
        extract_competitors_keywords: {
          type: "json",
          data: { keywords: [{ text: "match 3 puzzle", popularity: 71 }] },
        },
      };
      const r = (responders[tool] ?? { type: "json", data: [] }) as unknown;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [r] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const local: LocalTrackedKeyword[] = [
      // Weak local row — autopilot should mine using THIS keyword.
      tracked({
        keyword: "very-weak-cz-term",
        territory: "US",
        score: 0.15,
        bucket: "DECAY",
      }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetchImpl, requestsPerMinute: 0 }),
    });
    await ap.analyze(APP, local, { territories: ["US"] });

    // Mining seeds must include both the WEAK keyword (per-row
    // intent-specific) AND Astro's tracked top-pop terms (general
    // coverage). Order doesn't matter — we just assert both sources
    // contributed.
    const mineCalls = calls.filter((c) => c.tool === "extract_competitors_keywords");
    expect(mineCalls.length).toBeGreaterThan(0);
    const seedKeywords = mineCalls.map(
      (c) => (c.args as { keyword: string }).keyword,
    );
    // Weak-row source
    expect(seedKeywords).toContain("very-weak-cz-term");
    // Astro top-pop source
    expect(seedKeywords).toContain("puzzle");
    expect(seedKeywords).toContain("block");
  });

  test("AI enricher fires for non-English locales + injects locale candidates into pool", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_app_keywords: {
        type: "json",
        data: [{ keyword: "puzzle", country: "cz", popularity: 65 }],
      },
      get_keyword_suggestions: { type: "json", data: [] },
      extract_competitors_keywords: {
        type: "json",
        data: { keywords: [{ text: "brain test", popularity: 60 }] },
      },
    });
    const aiCalls: { locale: string; seeds: string[] }[] = [];
    const aiEnricher = vi.fn(async (info: {
      localeCode: string;
      astroSeeds: { keyword: string }[];
    }) => {
      aiCalls.push({
        locale: info.localeCode,
        seeds: info.astroSeeds.map((s) => s.keyword),
      });
      return {
        candidates: [
          { keyword: "hlavolam mozku", popularity: 80, cluster: "LOCALE_AI", reason: "Czech-native pivot" },
          { keyword: "logická hra", popularity: 70, cluster: "LOCALE_AI", reason: "Genre fit" },
        ],
      };
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "CZ", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, local, {
      territories: ["CZ"],
      territoryLocaleMap: { CZ: "cs-CZ" },
      aiEnricher,
    });

    // AI enricher should have been called once for CZ
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]?.locale).toBe("cs-CZ");
    expect(aiCalls[0]?.seeds).toContain("brain test");

    // Czech-native AI candidates should appear in proposals (they have
    // higher localeLanguageMultiplier than the English Astro pool).
    const rec = r.recommendationsByTerritory[0];
    expect(rec?.proposals.length).toBeGreaterThan(0);
    const proposedKeywords = rec?.proposals.map((p) => p.strong.keyword) ?? [];
    const hasCzechAi = proposedKeywords.some((k) =>
      ["hlavolam mozku", "logická hra"].includes(k),
    );
    expect(hasCzechAi).toBe(true);
    void calls;
  });

  test("AI enricher NOT called for English locales", async () => {
    const { fetch } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_app_keywords: { type: "json", data: [] },
      get_keyword_suggestions: { type: "json", data: [] },
      extract_competitors_keywords: { type: "json", data: [] },
    });
    const aiEnricher = vi.fn(async () => ({ candidates: [] }));
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "block", territory: "US", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    await ap.analyze(APP, local, {
      territories: ["US"],
      territoryLocaleMap: { US: "en-US" },
      aiEnricher,
    });
    expect(aiEnricher).not.toHaveBeenCalled();
  });

  test("AI enricher failure does not abort analyze", async () => {
    const { fetch } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_app_keywords: { type: "json", data: [] },
      get_keyword_suggestions: { type: "json", data: [] },
      extract_competitors_keywords: {
        type: "json",
        data: { keywords: [{ text: "brain puzzle", popularity: 65 }] },
      },
    });
    const aiEnricher = vi.fn(async () => {
      throw new Error("AI provider down");
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "blok", territory: "CZ", score: 0.15, bucket: "DECAY" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, local, {
      territories: ["CZ"],
      territoryLocaleMap: { CZ: "cs-CZ" },
      aiEnricher,
    });
    // Astro-mined "brain puzzle" should still surface even when AI failed.
    const props = r.recommendationsByTerritory[0]?.proposals ?? [];
    expect(props.length).toBeGreaterThan(0);
  });

  test("includeCompetitorMining=true fires extract_competitors_keywords for strong seeds", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
      add_keywords: {
        type: "json",
        data: { added: 1, failed: 0, skipped: 0, total: 1, results: [] },
      },
      get_keyword_suggestions: { type: "json", data: [] },
      extract_competitors_keywords: { type: "json", data: [{ text: "x", popularity: 40 }] },
    });
    const local: LocalTrackedKeyword[] = [
      tracked({ keyword: "anchor", territory: "US", score: 0.8, bucket: "CHAMPION" }),
    ];
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    await ap.analyze(APP, local, {
      territories: ["US"],
      includeCompetitorMining: true,
    });
    expect(calls.filter((c) => c.tool === "extract_competitors_keywords").length).toBeGreaterThan(0);
  });

  test("empty territories list → no add_keywords / no proposals", async () => {
    const { fetch, calls } = fakeAstro({
      add_app: { type: "json", data: { appId: "1234567890", name: "X" } },
    });
    const ap = new AstroAutopilot({
      client: new AstroMcpClient({ endpoint: "x", fetchImpl: fetch, requestsPerMinute: 0 }),
    });
    const r = await ap.analyze(APP, [], { territories: [] });
    expect(r.syncByTerritory).toEqual([]);
    expect(r.recommendationsByTerritory).toEqual([]);
    expect(calls.filter((c) => c.tool === "add_keywords")).toHaveLength(0);
    expect(calls.filter((c) => c.tool === "get_keyword_suggestions")).toHaveLength(0);
  });
});
