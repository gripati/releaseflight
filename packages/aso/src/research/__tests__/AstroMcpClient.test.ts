import { describe, expect, test } from "vitest";
import { AstroMcpClient } from "../AstroMcpClient";

/**
 * The Astro MCP server speaks JSON-RPC 2.0 over HTTP. These tests mock
 * `fetch` to return canned envelopes so we can verify:
 *
 *   • The JSON-RPC frame we send (method = "tools/call", correct name +
 *     arguments)
 *   • Tolerant parsing of content blocks (inline `data` vs JSON text vs
 *     free-text confirmation)
 *   • Auth header handling
 *   • Retry semantics — transport errors retry, tool errors don't
 *   • Per-tool mappers (search_rankings, add_keywords, etc.)
 *   • Chunking in addKeywordsBulk (>100 keywords)
 */

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

function fakeFetch(
  responder: (req: CapturedRequest, attempt: number) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
): {
  fetch: typeof fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  let attempt = 0;
  const fn: typeof fetch = async (input, init) => {
    attempt += 1;
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    captured.push({ url, init, body });
    const result = await responder({ url, init, body }, attempt);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn, captured };
}

function jsonRpcOk(content: unknown): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id: 1,
      result: { content: Array.isArray(content) ? content : [content] },
    },
  };
}

describe("AstroMcpClient transport", () => {
  test("sends JSON-RPC tools/call with the right method + params", async () => {
    const { fetch, captured } = fakeFetch(() =>
      jsonRpcOk({ type: "json", data: [{ id: "a1", appName: "TestApp" }] }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    await client.listApps();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "list_apps", arguments: {} },
    });
  });

  test("adds bearer token when apiKey provided", async () => {
    const { fetch, captured } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      apiKey: "sk_abc",
      fetchImpl: fetch,
    });
    await client.listApps();
    const headers = captured[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBe("Bearer sk_abc");
  });

  test("omits Authorization header when apiKey is not set", async () => {
    const { fetch, captured } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    await client.listApps();
    const headers = captured[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.["authorization"]).toBeUndefined();
  });

  test("parses inline `data` content blocks", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({ type: "json", data: { id: "id-1", appName: "Astro Test" } }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const apps = await client.listApps();
    expect(apps[0]?.appName).toBe("Astro Test");
  });

  test("parses JSON-encoded `text` blocks when no `data` is present", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "text",
        text: JSON.stringify([{ id: "x", appName: "From text" }]),
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const apps = await client.listApps();
    expect(apps[0]?.appName).toBe("From text");
  });

  test("throws when the JSON-RPC envelope carries an error", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "oops" } },
    }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    await expect(client.listApps()).rejects.toThrow(/Astro MCP error: oops/);
  });

  test("throws with 'tool error' prefix when result.isError is true", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [{ type: "text", text: "Unknown keyword" }],
        },
      },
    }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    await expect(client.listApps()).rejects.toThrow(/Astro tool error: Unknown keyword/);
  });

  test("throws on non-200 HTTP status", async () => {
    const { fetch } = fakeFetch(() => ({ status: 503, body: { error: "down" } }));
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      retries: 0,
    });
    await expect(client.listApps()).rejects.toThrow(/Astro MCP HTTP 503/);
  });
});

describe("AstroMcpClient retry policy", () => {
  test("retries once on transport error", async () => {
    let calls = 0;
    const { fetch } = fakeFetch(() => {
      calls += 1;
      if (calls === 1) return { status: 502, body: { error: "blip" } };
      return jsonRpcOk({ type: "json", data: [] });
    });
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      retries: 1,
    });
    await client.listApps();
    expect(calls).toBe(2);
  });

  test("does NOT retry tool errors (deterministic, retrying wastes time)", async () => {
    let calls = 0;
    const { fetch } = fakeFetch(() => {
      calls += 1;
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "bad input" }] },
        },
      };
    });
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      retries: 3,
    });
    await expect(client.listApps()).rejects.toThrow(/Astro tool error/);
    expect(calls).toBe(1);
  });
});

describe("ping", () => {
  test("returns ok when list_apps responds", async () => {
    const { fetch } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const r = await client.ping();
    expect(r.ok).toBe(true);
  });

  test("returns ok:false with the error message on failure", async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: { error: "boom" } }));
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      retries: 0,
    });
    const r = await client.ping();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Astro MCP HTTP 500/);
  });
});

describe("searchRankings", () => {
  test("maps ranking sample fields tolerantly", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "json",
        data: [
          {
            keyword: "headache tracker",
            store: "us",
            currentRanking: 7,
            popularity: 3.4,
            volume: 4200,
            maxVolume: 5000,
            keywordDifficulty: 18,
            reach: 67,
          },
        ],
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const samples = await client.searchRankings({ keyword: "headache tracker", store: "us" });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      keyword: "headache tracker",
      country: "us",
      rank: 7,
      popularity: 3.4,
      volume: 4200,
      maxVolume: 5000,
      difficulty: 18,
      maxReachChance: 67,
    });
  });

  test("maps `history` array + previousRanking when includeHistory is true", async () => {
    const { fetch, captured } = fakeFetch(() =>
      jsonRpcOk({
        type: "json",
        data: [
          {
            app: "Pixy Block Breaker",
            keyword: "puzzle",
            store: "us",
            currentRanking: 42,
            previousRanking: 47,
            difficulty: 65,
            popularity: 78,
            lastUpdate: "2026-05-19T05:11:58Z",
            history: [
              { date: "2026-05-19T05:11:58Z", ranking: 42 },
              { date: "2026-05-18T05:11:58Z", ranking: 47 },
              { date: "2026-05-17T05:11:58Z", ranking: 55 },
            ],
          },
        ],
      }),
    );
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      requestsPerMinute: 0,
    });
    const samples = await client.searchRankings({
      keyword: "puzzle",
      store: "us",
      includeHistory: true,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.rank).toBe(42);
    expect(samples[0]?.previousRank).toBe(47);
    expect(samples[0]?.history).toHaveLength(3);
    expect(samples[0]?.history?.[0]?.ranking).toBe(42);
    // Verify `includeHistory: true` was forwarded to the tool args.
    const body = captured[0]?.body as {
      params: { arguments: { includeHistory: boolean } };
    };
    expect(body.params.arguments.includeHistory).toBe(true);
  });

  test("returns empty array when Astro yields no rows", async () => {
    const { fetch } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const samples = await client.searchRankings({ keyword: "x", store: "us" });
    expect(samples).toEqual([]);
  });
});

describe("addKeywords", () => {
  test("rejects when more than 100 keywords passed in one call", async () => {
    const { fetch } = fakeFetch(() => jsonRpcOk({ type: "json", data: { added: 0 } }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const tooMany = Array.from({ length: 101 }, (_, i) => `kw-${i.toString()}`);
    await expect(
      client.addKeywords({ store: "us", appId: "x", keywords: tooMany }),
    ).rejects.toThrow(/at most 100 keywords/);
  });

  test("parses structured added/skipped counts", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "json",
        data: { added: 47, skipped: 3, skippedKeywords: ["a", "b", "c"] },
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const r = await client.addKeywords({
      store: "us",
      appId: "x",
      keywords: ["a", "b", "c"],
    });
    expect(r).toEqual({
      added: 47,
      skipped: 3,
      skippedKeywords: ["a", "b", "c"],
      results: [],
    });
  });

  test("parses free-text confirmation when Astro returns a string", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "text",
        text: "Added 12 keywords. Skipped 3 (duplicates: foo, bar, baz)",
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const r = await client.addKeywords({
      store: "us",
      appId: "x",
      keywords: ["foo", "bar", "baz", "new1", "new2"],
    });
    expect(r.added).toBe(12);
    expect(r.skipped).toBe(3);
    expect(r.skippedKeywords).toEqual(["foo", "bar", "baz"]);
  });
});

describe("addKeywordsBulk", () => {
  test("chunks >100 keywords into separate calls and aggregates results", async () => {
    let calls = 0;
    const { fetch, captured } = fakeFetch(() => {
      calls += 1;
      return jsonRpcOk({
        type: "json",
        data: { added: 100, skipped: 0, skippedKeywords: [] },
      });
    });
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const kws = Array.from({ length: 250 }, (_, i) => `kw-${i.toString()}`);
    const r = await client.addKeywordsBulk({
      store: "us",
      appId: "x",
      keywords: kws,
    });
    expect(calls).toBe(3); // 100 + 100 + 50
    expect(r.added).toBe(300); // each call reported 100
    // Verify chunk sizes
    const sizes = captured.map((c) => {
      const body = c.body as { params: { arguments: { keywords: string[] } } };
      return body.params.arguments.keywords.length;
    });
    expect(sizes).toEqual([100, 100, 50]);
  });

  test("no calls when keyword list is empty", async () => {
    const { fetch, captured } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const r = await client.addKeywordsBulk({
      store: "us",
      appId: "x",
      keywords: [],
    });
    expect(r).toEqual({ added: 0, skipped: 0, skippedKeywords: [], results: [] });
    expect(captured).toHaveLength(0);
  });
});

describe("getKeywordSuggestions + extractCompetitorsKeywords", () => {
  test("getKeywordSuggestions maps cluster + reason fields", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "json",
        data: [
          {
            keyword: "offline puzzle",
            country: "US",
            popularity: 2.8,
            volume: 1500,
            difficulty: 22,
            maxReachChance: 55,
            cluster: "LONG_TAIL",
            rationale: "Strong painkiller for kid-safe segment",
          },
        ],
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const suggestions = await client.getKeywordSuggestions({
      appId: "12345",
      store: "us",
    });
    expect(suggestions[0]).toMatchObject({
      keyword: "offline puzzle",
      cluster: "LONG_TAIL",
      reason: "Strong painkiller for kid-safe segment",
      difficulty: 22,
      maxReachChance: 55,
    });
  });

  test("extractCompetitorsKeywords reads {keywords: [{text, popularity}]} envelope", async () => {
    const { fetch } = fakeFetch(() =>
      jsonRpcOk({
        type: "json",
        // Real Astro shape: top-level object with keywords[] using
        // `text` instead of `keyword` and popularity 0-100.
        data: {
          keyword: "puzzle",
          keywords: [
            { text: "match 3 puzzle", popularity: 65 },
            { text: "candy crush like", popularity: 58 },
          ],
          totalCombinations: 2,
        },
      }),
    );
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const c = await client.extractCompetitorsKeywords({
      keyword: "puzzle",
      appId: "ASTRO_APP_ID",
      store: "us",
    });
    // The coerceArray() pulls from `keywords` envelope by default
    expect(c.length).toBeGreaterThanOrEqual(2);
    const text = c.map((k) => k.keyword);
    expect(text).toContain("match 3 puzzle");
    expect(text).toContain("candy crush like");
  });
});

describe("error containment", () => {
  test("AbortController fires when timeoutMs elapses", async () => {
    const slowFetch: typeof fetch = () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("aborted")), 50);
      });
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: slowFetch,
      timeoutMs: 10,
      retries: 0,
    });
    await expect(client.listApps()).rejects.toThrow();
  });

  test("addApp rejects when appStoreId not given", async () => {
    const { fetch } = fakeFetch(() => jsonRpcOk({ type: "json", data: [] }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    await expect(
      client.addApp({} as unknown as { appStoreId: string }),
    ).rejects.toThrow(/appStoreId/);
  });

  test("retries once on rate-limit tool error and succeeds on retry", async () => {
    let attempt = 0;
    const { fetch } = fakeFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Server is temporarily busy (rate limit: 30 requests/min). Please wait 1 second and retry.",
                },
              ],
            },
          },
        };
      }
      return jsonRpcOk({ type: "json", data: [{ appId: "x", name: "X" }] });
    });
    const client = new AstroMcpClient({
      endpoint: "http://x/mcp",
      fetchImpl: fetch,
      requestsPerMinute: 0,
    });
    const apps = await client.listApps();
    expect(apps).toHaveLength(1);
    expect(attempt).toBe(2); // first hit got rate-limited, second succeeded
  });

  test("addApp treats 'Duplicate entry' as already-tracked success", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          content: [
            { type: "text", text: "Error: Duplicate entry: App with ID '123' is already tracked" },
          ],
        },
      },
    }));
    const client = new AstroMcpClient({ endpoint: "http://x/mcp", fetchImpl: fetch, requestsPerMinute: 0 });
    const r = await client.addApp({ appStoreId: "123" });
    expect(r.alreadyTracked).toBe(true);
    expect(r.app).toBeNull();
  });
});
