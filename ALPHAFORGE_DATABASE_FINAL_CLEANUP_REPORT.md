# AlphaForge Database Final Cleanup Report

**Refactor:** data-service2.0 centralization  
**Branch:** `refactor/data-service-centralization`  
**Date:** 2026-09-14

---

## Tables Before Cleanup (35 total)

User, SignalHistory, Alert, UserSetting, Notification, PaperTrade, Strategy, StrategyBacktest, StrategyPaperTrade, IndiaDailyPick, **CandleBar**, **OptionChainSnapshot**, **OptionChainStrike**, FnoTrendScan, IndiaDaySession, SignalLifecycleEvent, **UniverseCoverageSnapshot**, OpportunityCluster, SignalIntelligenceRecord, IndiaPredictionRecord, IndiaResolutionRecord, **DataGap**, **DataQualityIncident**, **ProviderObservation**, **DataCorrection**, **InstrumentMasterSnapshot**, **InstrumentMasterEntry**, **RealtimeHistoricalMismatch**, **DataProvenance**, **DataReconciliation**, **DataQualityScore**, **HistoricalBackfillJob**, **RawAcquisitionRecord**, **FnoUniverseSnapshot**, **FnoUniverseEntry**

---

## Market-Data Tables Dropped (18 tables)

| Table | Reason | Migration |
|---|---|---|
| `CandleBar` | OHLCV storage now owned by data-service2.0 | `20260914000000_drop_market_data_tables` |
| `OptionChainSnapshot` | Option chain storage now owned by data-service2.0 | Same migration |
| `OptionChainStrike` | Per-strike time series now owned by data-service2.0 | Same migration |
| `DataGap` | Gap detection now owned by data-service2.0 | Same migration |
| `DataQualityIncident` | Quality incidents now owned by data-service2.0 | Same migration |
| `ProviderObservation` | Provider metrics now owned by data-service2.0 | Same migration |
| `DataCorrection` | Corrections now owned by data-service2.0 | Same migration |
| `InstrumentMasterSnapshot` | Instrument catalog now owned by data-service2.0 | Same migration |
| `InstrumentMasterEntry` | Instrument entries now owned by data-service2.0 | Same migration |
| `RealtimeHistoricalMismatch` | Reconciliation now owned by data-service2.0 | Same migration |
| `DataProvenance` | Provenance now owned by data-service2.0 lineage store | Same migration |
| `DataReconciliation` | Multi-source reconciliation now owned by data-service2.0 | Same migration |
| `DataQualityScore` | Quality scoring now owned by data-service2.0 | Same migration |
| `HistoricalBackfillJob` | Backfill tracking now owned by data-service2.0 | Same migration |
| `RawAcquisitionRecord` | Raw acquisition now owned by data-service2.0 | Same migration |
| `FnoUniverseSnapshot` | F&O universe now owned by data-service2.0 | Same migration |
| `FnoUniverseEntry` | F&O universe entries now owned by data-service2.0 | Same migration |
| `UniverseCoverageSnapshot` | Coverage tracking now owned by data-service2.0 | Same migration |

---

## Tables Retained (17 tables)

All retained tables are **trading/user data**, not market data:

| Table | Purpose |
|---|---|
| `User` | User authentication |
| `UserSetting` | Per-user preferences |
| `Alert` | Price/signal alert rules |
| `Notification` | In-app notifications |
| `Strategy` | User-defined strategies |
| `StrategyBacktest` | Backtest results |
| `StrategyPaperTrade` | Strategy paper trades |
| `PaperTrade` | Global paper trade journal |
| `SignalHistory` | Signal history |
| `SignalLifecycleEvent` | Signal state transitions |
| `FnoTrendScan` | F&O trend scanner results |
| `IndiaDaySession` | Daily session tracking |
| `IndiaDailyPick` | Daily pick board |
| `SignalIntelligenceRecord` | Full signal taxonomy |
| `IndiaPredictionRecord` | Closed-loop learning |
| `IndiaResolutionRecord` | Signal resolution records |
| `OpportunityCluster` | Signal deduplication |

---

## Migration File

`prisma/migrations/20260914000000_drop_market_data_tables/migration.sql`

Uses `DROP TABLE IF EXISTS` with correct FK-dependency order.

---

## Schema Validation

```
npx prisma validate → OK (no schema errors)
TypeScript compilation → 0 errors
```

---

## Conclusion

AlphaForge no longer stores any market data locally.
All historical candles, option chains, ticks, and market-data artifacts are owned by data-service2.0.
