/**
 * Release Flight ASO research package — exports.
 *
 * Astro is the SINGLE SOURCE OF TRUTH for ASO signal data (popularity,
 * difficulty, volume, ranking, history). Apple Search Ads, Apple Search
 * Hints, Google Trends, and the multi-provider fusion layer have been
 * removed in favour of Astro's first-party access via MCP. AI helpers
 * (relevance scorer + locale transcreation) stay because they OPERATE
 * on Astro's output rather than producing competing signals.
 */
export {
  type KeywordResearchMetrics,
  type Storefront,
  emptyMetrics,
} from "./types";
export {
  AstroMcpClient,
  type AstroMcpClientConfig,
  type AstroApp,
  type AstroTrackedKeyword,
  type AstroRankingSample,
  type AstroKeywordSuggestion,
  type AstroCompetitorKeyword,
  type AstroAddKeywordsResult,
} from "./AstroMcpClient";
export {
  AstroAutopilot,
  scoreAstroCandidate,
  isAsoNoiseCandidate,
  detectAppCategory,
  type AppCategory,
  localeLanguageMultiplier,
  type AutopilotApp,
  type LocalTrackedKeyword,
  type ProposeSwapsOptions,
  type ProposeSwapsResult,
  type SwapProposal,
  type ProposalKind,
  type SyncResult,
  type AnalyzeOptions,
  type AnalyzeResult,
  type AiEnricher,
  type AiEnricherInput,
  type AiEnricherOutput,
  type AiRelevanceScorer,
  type AiRelevanceScorerInput,
  type AiRelevanceScorerOutput,
} from "./AstroAutopilot";
