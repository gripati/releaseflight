# ASO Intelligence — Master Plan

> Phases 9 → 11 of the Release Flight roadmap. This document defines the
> AI-driven App Store Optimisation layer that turns raw analytics +
> keyword + trend data into recommendations a publisher can act on
> directly from the product UI.

## 1 · Vision

Today the product **manages metadata** for one app across stores. The
ASO layer turns it into a **decision system**:

```
   Apple Analytics  ─┐
   Apple Search Ads ─┤
   App Store search ─┼──►  Signals ─►  AI synthesis ─►  Recommendation
   Google Trends    ─┤      (Postgres)   (Claude)        + ROI estimate
   Competitor scrape ┘                                    + reasoning trace
                                                          + one-click apply
```

Concretely:

- For every tracked keyword: rank position, search-volume bucket, trend
  delta, our visibility share, competitor density.
- For every product page: impressions → PVCR funnel, per-source split
  (Search / Browse / Web Referrer / App Referrer), per-territory.
- For each insight: a Claude-authored *Why this matters · What to try ·
  Predicted lift · Risk* card the user reads in 30 seconds.
- For each "Apply": the system writes the new metadata/screenshots/CPP
  through the existing push pipeline.

The whole thing is **read-only by default**. The user always approves
the write — but the AI does the homework.

---

## 2 · Data sources

We integrate **7** upstream sources. Each has its own adapter under
`packages/core/src/adapters/<source>/` mirroring the existing Apple /
Google pattern.

### 2.1  App Store Connect Analytics API  ⭐ Primary

- **Endpoint base:** `https://api.appstoreconnect.apple.com/v1/analyticsReports`
- **Auth:** Existing Apple ES256 JWT (same `.p8` we already store)
- **Granularity:** Daily, weekly, monthly. We pull DAILY and roll up.
- **What we collect per app:**
  - `App Store Discovery and Engagement Standard` report family
    - Impressions (unique device count)
    - Product page views
    - Conversion rate (PVCR) — install / page view
    - First-time downloads
    - Total downloads
    - Re-downloads
    - Sessions
    - Active devices (1-day, 7-day, 30-day)
    - Crashes (signal of quality, affects ranking)
  - **Split by:**
    - Source (App Store Search, App Store Browse, App Referrer, Web Referrer, Institutional Purchase, Unavailable)
    - Territory (ISO 3166-1)
    - Device class (iPhone, iPad, AppleTV…)
    - App version
- **Storage:** `AnalyticsSnapshot` table (daily aggregates) + `AnalyticsFunnel` (source × territory × day).
- **Refresh:** Daily cron at 03:00 UTC (Apple data has ~36 h delay; pull yesterday-1).
- **Worker:** `aso.analytics.sync`.

### 2.2  Custom Product Pages API

- **Endpoint:** `/v1/customProductPages` + `/v1/customProductPageVersions`
- **Capabilities:**
  - List existing CPPs for an app (max 35)
  - Create a new CPP draft
  - Upload screenshots / app preview per locale per device
  - Set promotional text
  - Submit for review (separate flow from version submission)
  - Read traffic split + per-CPP analytics
- **Schema:** New `CustomProductPage` + `CustomProductPageLocalization` tables — same shape as App / AppLocalization but FK'd to the parent CPP, not the version.

### 2.3  Product Page Optimization (PPO) API

- **Endpoint:** `/v1/appStoreVersionExperiments`
- **Constraints:**
  - 1 control + max 3 treatments
  - 90-day max duration
  - 3 dimensions: app icon, screenshots, app preview
  - Apple distributes traffic (10-100% in 1% steps)
- **What we read:** treatment definitions, traffic share, daily impressions / installs per treatment, statistical significance.
- **What we write:** create experiment, upload treatment assets, start, pause, conclude (declare winner).
- **Schema:** `PpoExperiment`, `PpoTreatment`, `PpoMetric`.

### 2.4  Apple Search Ads — Campaign Management API

- **Endpoint base:** `https://api.searchads.apple.com/api/v5/`
- **Auth:** Separate OAuth2 (org-level cert + token). New `Credential.kind = APPLE_SEARCH_ADS`.
- **What we use (no campaigns required):**
  - `/v5/keyword-suggestions` — Apple's *own* search volume + bid recs
  - `/v5/search-popularity` — popularity index per keyword (0-5 scale)
  - `/v5/search-terms-report` — keywords driving installs to OUR app
- **Why it's gold:** This is Apple's *internal* search-volume signal, not third-party scraping. No tool except Search Ads has it.
- **Storage:** `KeywordSignal` table (keyword × territory × date × popularity × bid range).

### 2.5  App Store search rank scanner

Apple does not publish a "rank for keyword X" API. We **scrape**:

- iTunes Search API (`https://itunes.apple.com/search?term=X&country=US&entity=software`)
  - First 50 results, free, no auth, generous rate limit
  - Gives us rank of OUR app among results for keyword X
- **Daily scan:** For every tracked keyword × territory, run the search and record our position (1-50, or `null` = beyond top 50).
- **Storage:** `KeywordRankObservation` table (keyword, territory, rank, top10Apps[], scannedAt).
- **Worker:** `aso.keywords.scan` — batched, jittered, ~200ms between requests to avoid throttling.

### 2.6  Google Trends — `google-trends-api` npm package

- **Why:** Apple's signals are App-Store-only. Google Trends gives us *whole-web* interest as a leading indicator. A keyword spiking on Google often spikes on the App Store 1-3 weeks later.
- **What we read:**
  - 12-month interest time series per keyword × geo
  - Related queries ("breakout" — fast-rising terms)
- **Storage:** `KeywordTrend` table — keyword × geo × week × interestScore + breakoutQueries[].
- **Rate limit:** ~5 req/min to trends.google.com. We batch overnight.

### 2.7  AI Provider — Anthropic Claude (primary) / OpenAI (alternative)

- **Calls live in `packages/aso/src/ai/`** — provider-agnostic interface.
- **Prompt families:**
  - `analyseFunnel` — given 30 days of impressions/PVCR/downloads + per-source split, list the top 5 actionable insights.
  - `recommendKeywords` — given current tracked keywords, our app's category, the top competitor terms, and trend data, propose 10 new keyword candidates ranked by predicted impact.
  - `optimiseCopy` — given description + top keyword opportunities + character limits, propose 3 rewrites with each one's targeted keyword mix.
  - `briefCpp` — given an audience (search-only, social-paid-traffic, etc.), draft a Custom Product Page brief: which screenshots to swap, which promotional text to write, which keywords to target.
  - `designPpo` — propose the next PPO experiment hypothesis based on current PVCR baseline + recent failures.
- **Cost control:**
  - Embeddings cache (PG `pgvector`) for keyword lists and competitor sets — same input = same embedding, no re-query.
  - Per-tenant monthly token budget enforced in `aso.ai.analyze` worker.
- **Storage:** `AsoRecommendation` table (kind, payload JSON, predictedLiftPct, confidence, sourceSnapshotIds[], reasoningTrace, applied_at, applied_action_id).

---

## 3 · Database schema additions

New models (Prisma):

```prisma
model AnalyticsSnapshot {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId     String   @db.Uuid
  appId         String   @db.Uuid
  date          DateTime @db.Date
  // Roll-ups (across sources + territories)
  impressions          Int
  pageViews            Int
  downloads            Int
  firstTimeDownloads   Int
  redownloads          Int
  sessions             Int
  activeDevices1d      Int
  activeDevices7d      Int
  activeDevices30d     Int
  crashes              Int
  pvcrPct              Decimal @db.Decimal(5, 2)
  // raw payload for replay
  rawJson              Json
  createdAt            DateTime @default(now())
  @@unique([appId, date])
  @@index([tenantId, appId, date])
}

model AnalyticsFunnel {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  appId        String   @db.Uuid
  date         DateTime @db.Date
  source       String   // SEARCH | BROWSE | APP_REFERRER | WEB_REFERRER | INSTITUTIONAL | UNAVAILABLE
  territory    String   // ISO 3166-1 alpha-2
  impressions  Int
  pageViews    Int
  downloads    Int
  pvcrPct      Decimal @db.Decimal(5, 2)
  @@unique([appId, date, source, territory])
  @@index([tenantId, appId, date])
}

model TrackedKeyword {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId   String   @db.Uuid
  appId       String   @db.Uuid
  keyword     String
  territory   String   // ISO 3166-1
  source      String   // MANUAL | AI_SUGGESTED | APPLE_RECOMMENDED | COMPETITOR_BORROWED
  status      String   // ACTIVE | PAUSED | ARCHIVED
  createdById String?  @db.Uuid
  notes       String?
  createdAt   DateTime @default(now())
  @@unique([appId, keyword, territory])
  @@index([tenantId, appId, status])
}

model KeywordSignal {
  id                  String   @id @default(uuid()) @db.Uuid
  tenantId           String   @db.Uuid
  trackedKeywordId    String   @db.Uuid
  date                DateTime @db.Date
  applePopularity     Int?     // 0-5 from Apple Search Ads
  appleSuggestedBid   Decimal? @db.Decimal(6, 2)
  googleTrendsScore   Int?     // 0-100 from Google Trends
  appStoreRank        Int?     // 1..50, null = >50
  competitorCount     Int?     // distinct top-50 apps for this keyword
  ourVisibilityShare  Decimal? @db.Decimal(5, 2) // share of impressions we capture
  @@unique([trackedKeywordId, date])
  @@index([tenantId, date])
}

model CustomProductPage {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  appId           String   @db.Uuid
  appleCppId      String?  @unique
  name            String
  productPageUrl  String?  // the ?ppid=... URL Apple assigns
  state           String   // DRAFT | PREPARE | READY | LIVE | ARCHIVED
  createdById     String?  @db.Uuid
  createdAt       DateTime @default(now())
}

model PpoExperiment {
  id                     String   @id @default(uuid()) @db.Uuid
  tenantId              String   @db.Uuid
  appId                  String   @db.Uuid
  appleExperimentId      String?  @unique
  name                   String
  hypothesis             String?
  testingDimension       String   // ICON | SCREENSHOTS | APP_PREVIEW
  trafficSharePct        Int      // 1-100
  state                  String   // DRAFT | RUNNING | STOPPED | CONCLUDED
  winnerTreatmentId      String?
  startedAt              DateTime?
  endedAt                DateTime?
  // 1 control + max 3 treatments tracked in PpoTreatment
}

model PpoTreatment {
  id              String   @id @default(uuid()) @db.Uuid
  experimentId    String   @db.Uuid
  label           String   // "Control", "A", "B", "C"
  impressions     Int      @default(0)
  installs        Int      @default(0)
  pvcrPct         Decimal? @db.Decimal(5, 2)
  isWinner        Boolean  @default(false)
}

model AsoRecommendation {
  id                String   @id @default(uuid()) @db.Uuid
  tenantId         String   @db.Uuid
  appId             String   @db.Uuid
  kind              String   // KEYWORD_OPPORTUNITY | COPY_REWRITE | CPP_BRIEF | PPO_DESIGN | FUNNEL_INSIGHT
  title             String
  body              String   @db.Text
  payload           Json     // structured action data
  predictedLiftPct  Decimal? @db.Decimal(5, 2)
  confidence        String   // LOW | MEDIUM | HIGH
  reasoning         String   @db.Text  // AI chain-of-thought (redacted)
  status            String   // OPEN | APPLIED | DISMISSED | EXPIRED
  appliedActionId   String?  @db.Uuid // FK to the resulting Job
  generatedAt       DateTime @default(now())
  dismissedReason   String?
}
```

All new tables get the `tenantId` column + the same `apply_tenant_isolation()` migration line for RLS.

---

## 4 · Backend architecture

### 4.1  Package layout

```
packages/
  aso/                              ← NEW (pure logic, no I/O)
    src/
      scoring/
        keywordScore.ts             // composite score from 4 signals
        funnelDiagnostics.ts        // PVCR anomaly detection
      ai/
        AiProvider.ts               // interface (3 implementations behind it)
        providers/
          ClaudeProvider.ts         // Anthropic — tool_use JSON
          OpenAiProvider.ts         // OpenAI   — structured outputs JSON schema
          GeminiProvider.ts         // Google   — responseSchema in generationConfig
        AiOrchestrator.ts           // primary + fallback chain runner
        budget.ts                   // per-tenant monthly token / $ cap
        prompts/
          analyseFunnel.ts
          recommendKeywords.ts
          optimiseCopy.ts
          briefCpp.ts
          designPpo.ts
      simulation/
        liftEstimator.ts            // predict % uplift from a change
    package.json
    tsconfig.json

  core/src/adapters/
    apple-analytics/                ← NEW
      AnalyticsClient.ts
      AnalyticsReports.ts
    apple-search-ads/               ← NEW
      SearchAdsClient.ts
      KeywordSuggestions.ts
      SearchPopularity.ts
    app-store-search/               ← NEW
      iTunesSearch.ts               // public scraper, no auth
    google-trends/                  ← NEW
      TrendsClient.ts
```

### 4.2  New API routes (Next.js App Router)

```
apps/web/src/app/api/v1/apps/[id]/aso/
  analytics/route.ts                 // GET — last 30d funnel
  analytics/sync/route.ts            // POST — force a daily sync
  keywords/route.ts                  // GET/POST — list + add
  keywords/[kw]/route.ts             // GET/PATCH/DELETE — single tracked
  keywords/scan/route.ts             // POST — kick off a rank scan
  keywords/suggestions/route.ts      // POST — Apple Search Ads suggestions
  trends/[keyword]/route.ts          // GET — Google Trends 12 mo
  cpp/route.ts                       // GET/POST — list + create
  cpp/[cppId]/route.ts               // GET/PATCH/DELETE
  cpp/[cppId]/locales/[locale]/...
  ppo/route.ts                       // GET/POST
  ppo/[expId]/route.ts               // GET/PATCH (start/stop/conclude)
  recommendations/route.ts           // GET — open recs
  recommendations/generate/route.ts  // POST — request AI synthesis
  recommendations/[recId]/apply/route.ts  // POST — write through
```

### 4.3  Background jobs (BullMQ)

| Queue                  | Cron                  | What it does                                                   |
|------------------------|----------------------|----------------------------------------------------------------|
| `aso.analytics.sync`   | Daily 03:00 UTC      | Pull yesterday-1 analytics → AnalyticsSnapshot + AnalyticsFunnel |
| `aso.keywords.scan`    | Daily 04:00 UTC      | For every ACTIVE TrackedKeyword, hit iTunes search + Apple Search Ads → KeywordSignal |
| `aso.trends.refresh`   | Weekly Sunday 05:00  | Google Trends interest + breakouts → KeywordTrend             |
| `aso.cpp.sync`         | Daily 06:00 UTC      | Reconcile CPP state + per-CPP traffic                          |
| `aso.ppo.sync`         | Daily 06:30 UTC      | Pull PPO experiment metrics                                    |
| `aso.ai.analyze`       | Weekly Monday 09:00  | Synthesise recommendations across signals; on-demand via UI    |

All jobs:
- Tenant-scoped via `tenantStorage.run({ tenantId })`
- Idempotent (date+app+keyword is the natural key)
- Logged via `recordAudit({ action: "aso.*" })`
- Surfaced in the Jobs page with progress bar

---

## 5 · AI synthesis pipeline

### 5.1  Inputs

For each `recommendations/generate` call we assemble a **signal bundle**:

```ts
interface SignalBundle {
  app:              AppSummary;          // name, category, bundleId, primaryLocale
  funnel30d:        FunnelStats;          // daily impressions / PVCR / downloads
  funnelBySource:   SourceFunnel[];       // 6 sources × 30 days
  funnelByTerritory:TerritoryFunnel[];    // top 20 territories × 30 days
  trackedKeywords:  KeywordWithSignals[]; // popularity, rank, trend, share
  appleSuggested:   AppleSuggestion[];    // Apple's keyword recs for the app
  competitorSet:    CompetitorApp[];      // top-50 apps for each tracked keyword
  ppoHistory:       PpoExperiment[];      // past + active
  cppHistory:       CustomProductPage[];  // existing CPPs + their traffic
  marketTrends:     TrendSpike[];         // breakout queries this week
}
```

### 5.2  Prompt design

Each prompt follows a fixed JSON-schema response (Claude's `tool_use` /
OpenAI's `function_calling`). Example for `recommendKeywords`:

```json
{
  "type": "object",
  "properties": {
    "candidates": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "properties": {
          "keyword":              { "type": "string" },
          "predictedRank":        { "type": "integer", "minimum": 1, "maximum": 50 },
          "predictedLiftPct":     { "type": "number" },
          "rationale":            { "type": "string", "maxLength": 280 },
          "confidence":           { "enum": ["LOW","MEDIUM","HIGH"] },
          "competingApps":        { "type": "array", "items": { "type":"string" } },
          "targetCopySlot":       { "enum": ["title","subtitle","keywords","description-first-line","none"] }
        },
        "required": ["keyword","predictedLiftPct","rationale","confidence"]
      }
    },
    "summary": { "type":"string", "maxLength": 600 }
  }
}
```

Schema-locked output ⇒ we never have to parse free text.

### 5.3  Reasoning trace

Each `AsoRecommendation.reasoning` stores Claude's chain-of-thought
(`<thinking>` block) so the UI can show *"why we suggested this"*. The
trace is **redacted** of any user data outside the bundle to protect
privacy. Stored compressed (gzip → bytea).

### 5.4  Apply-through

When the user clicks **Apply** on a recommendation:
1. Validate the payload against the original schema (anti-tampering)
2. Translate the action to existing operations:
   - `KEYWORD_OPPORTUNITY` → add to `TrackedKeyword` + push keyword copy to next ASO copy edit
   - `COPY_REWRITE` → edit `AppLocalization` row → mark dirty → user pushes
   - `CPP_BRIEF` → create `CustomProductPage` draft preloaded with the brief
   - `PPO_DESIGN` → create `PpoExperiment` draft
3. Mark recommendation `APPLIED` + link to the produced job
4. Audit log entry

---

## 6 · Keyword scoring

A composite score balances signal sources. Computed daily into
`KeywordSignal.score`:

```
score = 0.35 · applePopularity_norm        // Apple's own search-volume bucket
      + 0.20 · googleTrendsScore_norm      // web interest
      + 0.20 · ourVisibilityShare_norm     // share of impressions we capture
      + 0.15 · rankInverse                 // 1/rank if in top-50
      + 0.10 · competitionGap              // (50 - competitorCount) / 50
```

Normalisation: per-territory min-max over the last 90 days.

**Ranking buckets** for UI:
- `Champion` (score ≥ 0.75) — we already win here, defend
- `Opportunity` (0.40 ≤ score < 0.75 AND rank > 10) — invest copy + bid
- `Rising` (trend up 50% this week) — early attention
- `Decay` (rank dropped 10+ in 7 days) — investigate

---

## 6.5 · Multi-provider AI orchestration

### The user picks 1 + 2

Each tenant configures (under `Settings → AI`) :
- **Primary provider** — one of `claude` · `openai` · `gemini`
- **Fallback chain** — an ordered list of the remaining two

Example: a tenant picks `gemini` as primary; the remaining `claude` and
`openai` can be chosen as `[openai, claude]` (try OpenAI first if Gemini
fails, then Claude). The chain is **per-tenant** and persisted in
`TenantSetting` under the key `aso.aiProvider`:

```jsonc
{
  "primary": "gemini",
  "fallbacks": ["openai", "claude"],
  "models": {
    "claude": "claude-opus-4-7",
    "openai": "gpt-5",
    "gemini": "gemini-2.5-pro"
  },
  "budgetMonthlyUsd": 50
}
```

API keys live in the existing `SecretProvider` next to Apple `.p8` and
Google service-account JSON — never in the database directly. A new
`Credential.kind` per provider:

| Kind | Material | Notes |
|---|---|---|
| `AI_ANTHROPIC` | `sk-ant-…` | Workspace can have one; multiple if rotating |
| `AI_OPENAI`    | `sk-…` (project key preferred) | Org id also captured for billing scoping |
| `AI_GEMINI`    | `AIzaSy…` | Or Vertex AI service-account JSON for enterprise |

If a key is missing for the configured provider, the AI surface degrades
gracefully — the *Recommendations* tab shows a "Connect AI provider" CTA
pointing at Settings.

### Provider implementation parity

All three SDKs natively support **schema-locked JSON output**, so our
prompt code stays provider-agnostic — only the transport changes:

| Capability | Claude (Anthropic SDK) | OpenAI (openai SDK) | Gemini (`@google/genai`) |
|---|---|---|---|
| JSON-locked output | `tool_use` + `input_schema` | `response_format: { type: "json_schema" }` | `responseMimeType: "application/json"` + `responseSchema` |
| Chain-of-thought | Native `<thinking>` block exposed | Reasoning summary (o-series) or none | Native `thoughts` field (2.5 Pro) |
| Streaming | SSE | SSE | SSE |
| Max context (May 2026) | 200k–1M | 200k–400k | 1M–2M |
| Token cost (Mtok in / out) | $3 / $15 (Sonnet), $15 / $75 (Opus) | $5 / $15 (gpt-5) | $1.25 / $5 (gemini-2.5-pro) |
| Vision (for screenshot intent analysis) | ✅ | ✅ | ✅ |

The `AiProvider` interface is the LCM of all three:

```ts
interface AiProvider {
  readonly name: "claude" | "openai" | "gemini";
  readonly model: string;
  readonly capabilities: {
    streaming: boolean;
    jsonSchema: boolean;
    reasoning: boolean;
    vision: boolean;
  };

  /**
   * Schema-locked call. Throws AiProviderError on rate limit / 5xx /
   * budget exceeded. The orchestrator catches that and tries the next
   * fallback in the chain.
   */
  generateStructured<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    schema: JSONSchema7;
    images?: ImagePart[];   // for vision (screenshot intent analysis)
    maxOutputTokens?: number;
    temperature?: number;
  }): Promise<{
    data: T;
    reasoning?: string;     // CoT trace if exposed
    usage: { inputTokens: number; outputTokens: number; usdCost: number };
  }>;

  estimateCost(inputTokens: number, outputTokens: number): number;
  healthCheck(): Promise<{ ok: boolean; latencyMs?: number; message?: string }>;
}
```

### `AiOrchestrator` — the fallback engine

```ts
class AiOrchestrator {
  constructor(private readonly providers: AiProvider[]) {}  // [primary, ...fallbacks]

  async generate<T>(input: GenerateInput<T>): Promise<GenerateResult<T>> {
    const attempts: AttemptLog[] = [];
    for (const p of this.providers) {
      try {
        await assertBudget(this.tenantId, p);          // monthly cap
        const result = await p.generateStructured<T>(input);
        attempts.push({ provider: p.name, ok: true, usage: result.usage });
        return { ...result, provider: p.name, attempts };
      } catch (err) {
        const retryable =
          err instanceof RateLimitError ||
          err instanceof ServerError ||
          err instanceof BudgetExceededError;
        attempts.push({ provider: p.name, ok: false, reason: err.message });
        if (!retryable) throw err;   // schema validation = unrecoverable, surface it
      }
    }
    throw new AiAllProvidersFailedError(attempts);
  }
}
```

**What triggers a fallback:**
- HTTP 429 (rate limit)
- HTTP 5xx
- Network timeout (15s default)
- Tenant monthly budget exceeded for that provider
- Specific JSON schema deserialise failure (one retry on same provider first, then fall through)

**What does NOT fall back:**
- HTTP 401 (bad key) — the user must fix the key; we don't silently switch
- HTTP 400 (prompt too long, content policy) — same prompt would fail
  on the next provider too, surface the error

Every recommendation record stores `attempts[]` so the user can see:
> *"Tried Gemini (rate-limited), fell back to OpenAI (success in 1.3s)."*

### UI — Settings → AI Provider

A new section in `/t/:slug/settings`:

```
AI Provider
───────────
PRIMARY
  ( ) Anthropic Claude          (no key configured)
  (●) Google Gemini             ✓ key: …kT4qA   (last 200 / $0.31 spent this month)
  ( ) OpenAI                    ✓ key: …r8nW7

FALLBACKS (drag to reorder)
  1. OpenAI       ✓
  2. Anthropic    (no key — disabled)

  [ Add Anthropic key ]
  [ Manage budget ($50/mo) ]    [ Test current chain ]
```

The **Test current chain** button fires a small `healthCheck` against
each provider and reports latency + token quota. Surfaces problems
before the user hits real recommendations.

### Cost guardrails

- `aso.ai.analyze` worker reads `TenantSetting.aso.aiProvider.budgetMonthlyUsd`
- Tracks cumulative `usdCost` per provider per month in `AiUsage` table
- At 80% of monthly budget → warning toast on next UI visit
- At 100% → orchestrator skips that provider and uses next fallback;
  if every provider over budget → `BudgetExceededError` → recommendations
  paused until next month (or user increases budget)

### Schema additions for multi-provider

```prisma
model AiUsage {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @db.Uuid
  provider     String   // claude | openai | gemini
  model        String
  yearMonth    String   // "2026-05"
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  usdCost      Decimal  @default(0) @db.Decimal(10, 4)
  requestCount Int      @default(0)
  @@unique([tenantId, provider, yearMonth])
  @@index([tenantId, yearMonth])
}
```

`TenantSetting.aso.aiProvider` stores the chain JSON; existing
`Credential.kind` enum extended to include `AI_ANTHROPIC` / `AI_OPENAI` /
`AI_GEMINI`.

---

## 7 · UI — new pages under `/t/:slug/apps/:appId/aso/`

The app-detail layout gains an **"ASO"** tab. Inside, a sub-nav:

```
Overview · Analytics · Keywords · Custom Pages · Experiments · Recommendations
```

### 7.1  Overview (default landing)

Five editorial KPI cards:
1. **Conversion Rate (PVCR)** — last 30d + sparkline
2. **Impressions** — last 30d, broken by Search vs Browse
3. **Top growing keyword** — name + Δ rank, breakout indicator
4. **Open recommendations** — count + highest predicted lift
5. **Active experiments** — running PPO + leading treatment

### 7.2  Analytics

- Funnel: Impressions → PV → Installs (Sankey diagram or three-bar chart)
- Per-source split table
- Per-territory heatmap (world map, intensity = PVCR)
- Trend chart with annotations: when we pushed metadata, when CPP changed, when PPO concluded

### 7.3  Keywords

- Filter chips: All / Champion / Opportunity / Rising / Decay
- Table columns: keyword, rank, score, popularity (Apple bars), trend (Google sparkline), our visibility share, last updated
- **Add keyword** sheet with autosuggest from Apple Search Ads + competitor borrow
- Per-keyword detail page:
  - 90-day rank chart
  - Trend chart (Google)
  - Top-10 apps ranking for it
  - "Force scan" button
  - "Generate copy suggestion" → AI

### 7.4  Custom Pages

- Grid of CPPs (cards) with thumbnail screenshot + traffic %
- Create CPP wizard:
  1. Audience brief (search-only, paid social, sub-keyword)
  2. AI proposes screenshot order + promo text
  3. User reviews + accepts → CPP draft saved + ready to upload assets

### 7.5  Experiments

- List of PPO experiments with status + statistical confidence
- Create experiment wizard with AI hypothesis seeding
- Live results chart with significance shading

### 7.6  Recommendations

The **command centre**. List of open recs sorted by `predictedLiftPct`.

Each recommendation card:
```
┌────────────────────────────────────────────────────────────┐
│  KEYWORD_OPPORTUNITY                          ⬆ +14.2%   │
│  "merge puzzle game" — add to subtitle                    │
│                                                            │
│  Why this matters                                          │
│  Apple popularity 4/5, Google Trends +38% last 30 days.   │
│  None of the top 10 apps include this exact phrase in     │
│  their subtitle. Our current subtitle uses generic        │
│  "puzzle solitaire" which has popularity 3/5.             │
│                                                            │
│  Predicted impact                                          │
│  +14.2% PVCR on Search traffic (HIGH confidence)          │
│  ≈ +180 installs / week at current impression volume      │
│                                                            │
│  [ View reasoning trace ]  [ Dismiss ]  [ Apply ]         │
└────────────────────────────────────────────────────────────┘
```

Apply → modifies the subtitle on en-US → marks dirty → user pushes via
the existing Push flow. Audit log captures both the rec and the resulting push.

---

## 8 · Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| AI providers | **Claude** + **OpenAI** + **Gemini**, all behind the `AiProvider` interface. Tenant picks one as PRIMARY + 0-2 from the remaining as ordered FALLBACK chain. | No vendor lock-in. Each provider has its own JSON-locked output mode (tool_use / json_schema / responseSchema); all three support streaming + vision. |
| AI orchestrator | `packages/aso/src/ai/AiOrchestrator.ts` — runs provider chain, catches rate-limit / 5xx / budget-exceeded, hops to next fallback, records `attempts[]` per generation | Surfaces "tried X, fell back to Y" in the recommendation UI so cost / latency is debuggable |
| AI key storage | New `Credential.kind` values: `AI_ANTHROPIC` / `AI_OPENAI` / `AI_GEMINI` — material in existing `SecretProvider` | Same encryption + rotation model as Apple `.p8` and Google service-account JSON |
| Astro ASO tool | **No direct integration possible** (Mac-only desktop app, no API). Phase 10 adds an optional **CSV import** flow for users who already pay for Astro — their keyword + popularity columns enrich `KeywordSignal` rows tagged `source = "ASTRO_CSV"`. | Apple Search Ads + iTunes scan + Google Trends already cover ~85% of Astro's signal; CSV import closes the gap for power users without us paying Astro's subscription |
| Embeddings | OpenAI `text-embedding-3-small` (512d) — also has Gemini fallback (`text-embedding-004`, 768d) and local `Xenova/all-MiniLM-L6-v2` for self-host with no API budget | Cache historical recs + competitor copies; avoids re-querying for identical inputs |
| Vector store | `pgvector` extension on the existing Postgres | One database, RLS-scoped, no new infra |
| Google Trends | `google-trends-api` npm package | No official API; this is the canonical reverse-engineered client |
| App Store search | `node-fetch` against `https://itunes.apple.com/search` | Free, no auth, generous rate limit |
| Charts | `visx` or `tremor` | Both compose well with our editorial token system |
| World map | `@react-jvectormap` or `react-simple-maps` | Lightweight, no Mapbox key |
| Job orchestration | Existing BullMQ | Reuse `aso.*` queues |
| Cron | BullMQ repeatable jobs | Already in `apps/worker` |

---

## 9 · Implementation phases

### Phase 9 — Foundation (2 weeks)
1. Prisma schema additions + RLS migration
2. `@marquee/aso` package skeleton + scoring math
3. Apple Analytics adapter — daily snapshot pull
4. Apple Search Ads adapter — keyword suggestions + popularity
5. iTunes search adapter — rank scan
6. Two new BullMQ jobs: `aso.analytics.sync` + `aso.keywords.scan`
7. ASO tab in app-detail layout (skeleton page)
8. `Overview` + `Analytics` page (read-only, no AI yet)

### Phase 10 — Keyword intelligence (2 weeks)
1. Google Trends adapter
2. KeywordSignal scoring pipeline
3. `Keywords` page with table + filters
4. Per-keyword detail page with charts
5. Force-scan UI + audit
6. Apple Search Ads credential type added to Credentials flow (new
   `Credential.kind = APPLE_SEARCH_ADS` + UI in AddCredentialSheet)

### Phase 11 — AI recommendations (3 weeks)
1. `AiProvider` interface + Claude implementation
2. `analyseFunnel` + `recommendKeywords` prompts
3. `aso.ai.analyze` weekly job
4. `Recommendations` page + apply-through wiring
5. Reasoning trace UI
6. Token budget enforcement + monthly cost tracking per tenant

### Phase 12 — Custom Product Pages (2 weeks)
1. CPP schema + Apple adapter
2. Create CPP wizard (with AI brief)
3. Per-CPP analytics
4. Upload assets via existing screenshot upload pipeline (just FK'd to CPP)

### Phase 13 — Product Page Optimization (2 weeks)
1. PPO schema + Apple adapter
2. Create experiment wizard
3. Live results chart
4. AI-designed experiment hypothesis
5. Automatic winner promotion when significance ≥ 95%

### Phase 14 — Automation polish (1 week)
1. Auto-apply low-risk recs (config flag, default off)
2. Slack / Mailgun digest of weekly recs
3. Per-tenant ASO health score (gamification)

**Total estimated effort:** 12 calendar weeks for a single full-time engineer; 6 weeks with two.

---

## 10 · Cost model

For a tenant with 5 apps tracking 100 keywords each over 50 territories,
**the AI bill varies by which provider is set as primary.** Here are all
three for the same monthly workload (~200 recs/mo @ ~5k tok in / ~1.2k
tok out + 4 weekly digests @ ~10k tok in / ~2.5k tok out):

| Item | Volume | Free | If Claude primary | If OpenAI primary | If Gemini primary |
|---|---|---|---:|---:|---:|
| App Store Connect Analytics | 155 calls/mo | ✅ | $0 | $0 | $0 |
| Apple Search Ads suggestions | 500/mo | ✅ | $0 | $0 | $0 |
| iTunes search rank scans | 775k req/mo | ✅ rate-limited | $0 | $0 | $0 |
| Google Trends | 2.2k req/mo | ✅ | $0 | $0 | $0 |
| AI recommendations (analysis) | 200 × (5k in + 1.2k out) | – | **~$6.6** (Sonnet) | **~$8.6** (gpt-5-mini) | **~$2.4** (gemini-2.5-flash) |
| AI weekly synthesis | 4 × (10k in + 2.5k out) | – | **~$1.4** (Opus) | **~$0.4** (gpt-5) | **~$0.1** (gemini-2.5-pro) |
| Embeddings | 5k/mo | – | <$1 | <$1 | <$1 |
| **Total / tenant / month** |   |   | **≈ $9** | **≈ $10** | **≈ $4** |

(Numbers based on May 2026 published prices. Anthropic Sonnet 4.6 $3/$15
per Mtok, OpenAI gpt-5 $5/$15, Gemini 2.5 Pro $1.25/$5. We use cheaper
tiers — Sonnet, gpt-5-mini, gemini-2.5-flash — for individual
recommendations and the flagship model only for weekly synthesis.)

**Self-host story stays clean:** every AI provider is optional. Tenant
without any AI credential gets the full analytics + keyword + trend
features; the *Recommendations* tab shows a friendly "Connect an AI
provider in Settings to unlock AI suggestions" CTA. With fallback
chains, a self-host operator can also start with Gemini (cheapest, ~$4
/mo) and add Claude/OpenAI later if they want different reasoning
styles.

---

## 11 · Privacy + safety

- **No PII to the LLM.** The signal bundle never contains user emails,
  IPs, or device identifiers. Only aggregate analytics + public keyword
  data.
- **Tenant isolation** at every layer: prompts include tenantId in the
  context but the `AiProvider` strips it before sending to upstream.
- **Audit log every AI write-through** — the `applied_action_id` FK lets
  us reconstruct any change from rec → job → metadata push.
- **Recommendation expiry** — recs unapplied for 30 days are
  auto-marked `EXPIRED` so stale advice doesn't accumulate.
- **Dry-run mode** — every `apply` endpoint supports `?dryRun=true`
  returning the proposed change without writing.

---

## 12 · KPIs we'll watch

- **% of active apps with ≥1 applied recommendation per month** —
  adoption metric
- **Median PVCR delta after applied rec** — outcome metric
- **Time from rec generation to apply** — friction metric
- **AI token spend per tenant** — cost discipline
- **Push success rate after AI-suggested copy** — quality signal

---

## 13 · Open questions for V1

1. Do we offer multi-territory recommendations or focus on the
   primary locale first? *Recommend: primary locale only in Phase 11, expand in Phase 14.*
2. Should auto-apply be opt-in per tenant or per app? *Recommend: per app, with workspace-wide default.*
3. Do we expose the reasoning trace to the user as-is or summarised?
   *Recommend: collapsed by default, "Show reasoning" expands the 200-500 char trace.*
4. Self-host installs without ANY AI key — degrade gracefully?
   *Recommend: yes. Analytics, keyword rank, and trend data work fully;
   recommendations tab shows a "Connect an AI provider" CTA pointing at Settings.*
5. **Default AI provider when a new tenant connects an app store?**
   *Recommend: no default — first-run wizard asks the user to pick.
   Show the cost table from §10 so they choose with their eyes open.
   Pre-flight a single test prompt against their chosen primary to
   catch bad keys before the first real recommendation runs.*
6. **Cross-provider response consistency?** Each model has its own
   style; the same prompt yields slightly different rationales.
   *Recommend: we normalise the JSON structure (schema-locked output
   guarantees this) but keep the prose as-is. Show the provider name
   on every recommendation card so users learn each model's voice.*
7. **Astro CSV import — when in roadmap?** *Recommend: Phase 10
   (Keyword Intelligence). Small bolt-on: one upload sheet + a parser
   for Astro's `keyword,popularity,chance,rank,results` schema. ~1 day
   of effort total.*
