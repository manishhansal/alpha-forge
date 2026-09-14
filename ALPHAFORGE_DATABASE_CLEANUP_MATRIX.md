# AlphaForge Database Cleanup Matrix
## data-service2.0 Centralization Refactor — Phase 2

Generated as part of the `refactor/data-service-centralization` branch.

All market-data tables are being dropped from the AlphaForge PostgreSQL database. Historical candles, option chains, gaps, quality incidents, reconciliation records, backfill jobs, instrument masters, F&O universe snapshots, and provenance records will be owned exclusively by **data-service2.0**. AlphaForge retains only the models that drive user-facing features: strategies, alerts, paper trades, signals, and India-specific decision records.

---

## Prisma Model Inventory

| Model | Purpose | Market Data? | Action | Reason |
|---|---|---|---|---|
| `User` | Auth — user account | No | **KEEP** | Core user identity |
| `UserSetting` | Per-user preferences (theme, API keys) | No | **KEEP** | App settings |
| `Alert` | Price/signal alert rules | No | **KEEP** | User feature |
| `Notification` | In-app and email notification records | No | **KEEP** | User feature |
| `Strategy` | User-defined natural-language strategy | No | **KEEP** | Core product |
| `StrategyBacktest` | Backtest result snapshot per strategy | No | **KEEP** | Core product |
| `StrategyPaperTrade` | Live paper trades from a saved Strategy | No | **KEEP** | Core product |
| `PaperTrade` | Shared paper-trade journal (scalper + India) | No | **KEEP** | Core product |
| `SignalHistory` | Historical signal records | No | **KEEP** | Core product |
| `SignalLifecycleEvent` | Signal state-transition audit log | No | **KEEP** | Signal engine audit |
| `FnoTrendScan` | India F&O trend scanner daily results | No | **KEEP** | India feature |
| `IndiaDaySession` | India auto-trader daily session tracking | No | **KEEP** | India feature |
| `IndiaDailyPick` | India daily pick board | No | **KEEP** | India feature |
| `SignalIntelligenceRecord` | Full enriched signal taxonomy envelope | No | **KEEP** | Signal engine |
| `IndiaPredictionRecord` | Closed-loop learning prediction snapshot | No | **KEEP** | Signal learning |
| `IndiaResolutionRecord` | Closed-loop learning resolution record | No | **KEEP** | Signal learning |
| `OpportunityCluster` | De-duplication cluster for concurrent signals | No | **KEEP** | Signal engine |
| `CandleBar` | OHLCV candle history | **Yes** | **DROP** | Owned by data-service2.0 |
| `OptionChainSnapshot` | Periodic NSE option-chain aggregate snapshots | **Yes** | **DROP** | Owned by data-service2.0 |
| `OptionChainStrike` | Per-strike option chain time series | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataGap` | Candle continuity gap records | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataQualityIncident` | Data quality incident log | **Yes** | **DROP** | Owned by data-service2.0 |
| `ProviderObservation` | Raw provider observation evidence | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataCorrection` | Historical candle correction log | **Yes** | **DROP** | Owned by data-service2.0 |
| `InstrumentMasterSnapshot` | Versioned NSE instrument master snapshot header | **Yes** | **DROP** | Owned by data-service2.0 |
| `InstrumentMasterEntry` | Per-instrument entry in a master snapshot | **Yes** | **DROP** | Owned by data-service2.0 |
| `RealtimeHistoricalMismatch` | Realtime vs historical candle divergences | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataProvenance` | Dataset acquisition provenance record | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataReconciliation` | Multi-source candle reconciliation | **Yes** | **DROP** | Owned by data-service2.0 |
| `DataQualityScore` | Deterministic quality score per dataset | **Yes** | **DROP** | Owned by data-service2.0 |
| `HistoricalBackfillJob` | Resumable historical acquisition job tracker | **Yes** | **DROP** | Owned by data-service2.0 |
| `RawAcquisitionRecord` | Raw provider response landing zone | **Yes** | **DROP** | Owned by data-service2.0 |
| `FnoUniverseSnapshot` | Versioned NSE F&O equity universe header | **Yes** | **DROP** | Owned by data-service2.0 |
| `FnoUniverseEntry` | Per-constituent row in a universe snapshot | **Yes** | **DROP** | Owned by data-service2.0 |
| `UniverseCoverageSnapshot` | Per-session F&O universe coverage metrics | **Yes** | **DROP** | Owned by data-service2.0 |

---

## Enums Removed

The following enums are **only referenced by dropped models** and are removed from `schema.prisma`:

| Enum | Referenced by (dropped) | Action |
|---|---|---|
| `DataTrustStatusEnum` | `DataProvenance` | **REMOVE** (if defined; field uses raw String) |
| `DataGapStatusEnum` | `DataGap` | **REMOVE** (if defined; field uses raw String) |
| `DataIncidentSeverityEnum` | `DataQualityIncident` | **REMOVE** (if defined; field uses raw String) |
| `BackfillJobStatusEnum` | `HistoricalBackfillJob` | **REMOVE** (if defined; field uses raw String) |

> Note: The schema uses raw `String` types for all status/severity/trust fields in the dropped models rather than Prisma enums. No enum removals are required.

---

## Enums Retained

| Enum | Referenced by (kept) |
|---|---|
| `SymbolEnum` | `User`, `Alert`, `UserSetting`, `SignalHistory`, `Notification`, `Strategy`, `StrategyBacktest`, `StrategyPaperTrade` |
| `SignalTypeEnum` | `SignalHistory` |
| `RiskLevelEnum` | `SignalHistory` |
| `AlertTypeEnum` | `Alert` |
| `AlertChannelEnum` | `Alert` |
| `SignalOutcomeEnum` | `SignalHistory` |
| `NotificationKindEnum` | `Notification` |
| `ScalpDirectionEnum` | `PaperTrade`, `StrategyPaperTrade` |
| `PaperTradeStatusEnum` | `PaperTrade`, `StrategyPaperTrade` |
| `StrategyBacktestPeriodEnum` | `StrategyBacktest` |

---

## Migration

Migration file: `prisma/migrations/20260914000000_drop_market_data_tables/migration.sql`

Drop order respects FK dependencies: child tables (`FnoUniverseEntry`, `InstrumentMasterEntry`, `OptionChainStrike`) are dropped before their parents (`FnoUniverseSnapshot`, `InstrumentMasterSnapshot`, `OptionChainSnapshot`).

---

## Route Impact

| Route | Change |
|---|---|
| `GET /api/in/historical-data/status` | Proxies data-service2.0 `/v1/health/live` and `/v1/analytics/providers` |
| `GET /api/in/historical-data/reconciliation` | Returns 200 with redirect note — reconciliation now in data-service2.0 |
| `GET /api/in/historical-data/gaps` | Proxies data-service2.0 `/v1/india/historical/gaps` |
| `GET /api/in/data/forensics/[tradeId]` | Paper trade lookup kept; `dataProvenance` DB query removed |
| `GET /api/in/historical-data/universe` | Rewired to call `DataServiceClient.universe.fno()` |
| `src/features/india/scalping/option-chain-capture.ts` | DB write to `optionChainSnapshot` removed |
