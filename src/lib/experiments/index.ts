/**
 * src/lib/experiments/index.ts
 *
 * Public surface of the Shadow Trading & Strategy Experiment Framework.
 *
 * Import from this barrel rather than from individual modules so internal
 * restructuring never breaks consumer import paths.
 *
 * Singletons exported
 * ────────────────────
 *   globalVersionRegistry   — StrategyVersionRegistry
 *   globalExperimentManager — ExperimentManager
 *   globalPromotionEngine   — PromotionEngine
 *   comparisonEngine        — ComparisonEngine
 */

// ── Version registry ───────────────────────────────────────────────────────────
export type {
  VersionStage,
  VersionStatus,
  StrategyVersionMeta,
  ModelVersionMeta,
  FeatureVersionMeta,
  VersionStamp,
} from "./strategy-version";
export { StrategyVersionRegistry, globalVersionRegistry } from "./strategy-version";

// ── Experiment manager ─────────────────────────────────────────────────────────
export type {
  ExperimentMode,
  MarketTick,
  SignalDirection,
  ExperimentSignal,
  SimulatedFill,
  ArmRole,
  ExperimentArm,
  ExperimentStatus,
  Experiment,
  CreateExperimentInput,
  AddArmInput,
  ArmTickResult,
  ArmStrategyHandler,
  ExperimentManagerSnapshot,
} from "./experiment-manager";
export { ExperimentManager, globalExperimentManager } from "./experiment-manager";

// ── Shadow trader ──────────────────────────────────────────────────────────────
export type {
  PositionStatus,
  CloseReason,
  ShadowPosition,
  ShadowTrade,
  ShadowPortfolioState,
  ShadowEquityPoint,
  BenchmarkPoint,
  AuditEventType,
  AuditLogEntry,
  ShadowTraderConfig,
  ShadowSummary,
} from "./shadow-trader";
export { ShadowTrader } from "./shadow-trader";

// ── Comparison engine ──────────────────────────────────────────────────────────
export type {
  ArmMetrics,
  PairwiseComparison,
  BenchmarkComparison,
  ComparisonReport,
  ArmComparisonInput,
  BenchmarkComparisonInput,
  ComparisonInput,
} from "./comparison";
export { ComparisonEngine, comparisonEngine } from "./comparison";

// ── Promotion engine ───────────────────────────────────────────────────────────
export type {
  ShadowToPaperGates,
  PromotionEngineConfig,
  PromotionCheckStatus,
  GateResult,
  PromotionCheckResult,
  ApprovalToken,
  PromotionEventType,
  PromotionAuditRecord,
  ReadinessSummary,
} from "./promotion";
export {
  PromotionEngine,
  globalPromotionEngine,
  DEFAULT_SHADOW_TO_PAPER_GATES,
} from "./promotion";
