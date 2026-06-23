export * from "./types";
export { keywordScore } from "./scoring/keywordScore";
export { detectFunnelAnomalies } from "./scoring/funnelDiagnostics";
export { multiWordBoost } from "./scoring/multipliers";
export {
  temporalBucket,
  applyTemporalOverride,
  type HistoricalSignal,
  type TemporalBucket,
} from "./scoring/temporalBucket";
export {
  validateKeywordToken,
  validateKeywordsField,
  type KeywordWarning,
  type KeywordValidationContext,
  type ValidationSeverity,
} from "./scoring/keywordFieldValidation";
export {
  SEASONAL_THEMES,
  getCurrentSeasonalThemes,
  getUpcomingSeasonalThemes,
  type SeasonalTheme,
} from "./scoring/seasonalCalendar";
export {
  runDailyCheck,
  type DailyCheckInput,
  type DailyCheckResult,
  type NotificationRecord,
} from "./scoring/dailyCheck";
export {
  diffCompetitorSnapshots,
  DEFAULT_DIFF_THRESHOLDS,
  type CompetitorChangeEvent,
  type CompetitorChangeKind,
  type CompetitorChangeSeverity,
  type CompetitorSnapshotInput,
  type DiffThresholds,
} from "./scoring/competitorDiff";
export {
  summariseRankMovers,
  topClimbers,
  topDecliners,
  type MoverDirection,
  type RankMover,
  type RankMoversSummary,
} from "./scoring/rankMovers";
export {
  summariseAdoptedPerformance,
  type AdoptedPerformanceInput,
  type AdoptedPerformanceSummary,
  type AdoptedVerdict,
} from "./scoring/adoptedPerformance";
export {
  getAuthorityTier,
  resolveMaxDifficulty,
  type AuthorityTier,
  type AuthorityTierResult,
} from "./scoring/authorityTier";
export {
  DEFAULT_THRESHOLDS,
  evaluateAllAlarms,
  evaluateBucketDegradation,
  evaluateCompetitorIntrusion,
  evaluateConversionDrop,
  evaluateKeywordRankDrop,
  evaluateKeywordRankEntry,
  evaluateKeywordRankExit,
  evaluateKeywordRankRise,
  evaluateRatingDrop,
  evaluateReviewSentiment,
  type AlarmEvaluationInput,
  type AlarmEvent,
  type AlarmKind,
  type AlarmSeverity,
  type AlarmThresholds,
  type BucketDegradationThreshold,
  type CompetitorIntrusionThreshold,
  type CompetitorRankDelta,
  type ConversionDelta,
  type ConversionDropThreshold,
  type KeywordRankDelta,
  type KeywordRankDropThreshold,
  type KeywordRankEntryThreshold,
  type KeywordRankExitThreshold,
  type KeywordRankRiseThreshold,
  type NewOpportunityKeywordThreshold,
  type RatingDelta,
  type RatingDropThreshold,
  type ReviewSentimentThreshold,
} from "./scoring/alarmEngine";
export * from "./ai";
export * from "./research";
