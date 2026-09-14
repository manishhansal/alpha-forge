# Final Database Audit Report

**Date:** 2026-09-15 | **Branch:** `refactor/alpha-forge`

## Prisma Schema Validation

```
npx prisma validate
→ The schema at prisma/schema.prisma is valid 🚀
```

## Remaining Application Tables

These are all legitimate business tables — no market data.

| Table (model) | Category | Purpose |
|---------------|----------|---------|
| `User` | CORE — User data | Auth, profile |
| `UserSetting` | CORE — User data | Theme, API keys (encrypted), data sources |
| `Alert` | CORE — Business | Price alerts configuration |
| `Notification` | CORE — Business | Alert delivery notifications |
| `Strategy` | CORE — Business | User strategy configurations |
| `SignalHistory` | SIGNAL DATA | Historical signal records with outcomes |
| `PaperTrade` | TRADING/EXECUTION | Paper trade records (scalper) |
| `StrategyBacktest` | ANALYTICS | Strategy backtest results |
| `StrategyPaperTrade` | TRADING/EXECUTION | Strategy paper trade records |
| `IndiaDailyPick` | SIGNAL DATA | Daily pick signals with outcomes |
| `IndiaDaySession` | SIGNAL DATA | Session-level market state |
| `FnoTrendScan` | ANALYTICS | F&O trend scanner results |
| `IndiaPredictionRecord` | ML DATA | ML prediction records |
| `IndiaResolutionRecord` | ML DATA | Signal resolution records |
| `SignalIntelligenceRecord` | SIGNAL DATA | Multi-layer signal intelligence |
| `SignalLifecycleEvent` | SIGNAL DATA | Signal state transitions |
| `OpportunityCluster` | ANALYTICS | Opportunity clustering data |

**Total remaining tables: 17**  
**Market data tables: 0**

## Removed Market-Data Tables

All removed via migration `20260914000000_drop_market_data_tables.sql`:

| Table | Category | Removed |
|-------|----------|---------|
| `candle_bar` | OHLCV market data | ✅ Dropped |
| `data_gap` | Market data quality | ✅ Dropped |
| `data_quality_incident` | Market data quality | ✅ Dropped |
| `provider_observation` | Provider metrics | ✅ Dropped |
| `data_correction` | Market data quality | ✅ Dropped |
| `realtime_historical_mismatch` | Market data quality | ✅ Dropped |
| `data_provenance` | Data sourcing | ✅ Dropped |
| `data_reconciliation` | Data quality | ✅ Dropped |
| `data_quality_score` | Data quality | ✅ Dropped |
| `historical_backfill_job` | Market data ingestion | ✅ Dropped |
| `raw_acquisition_record` | Market data ingestion | ✅ Dropped |
| `universe_coverage_snapshot` | Instrument universe | ✅ Dropped |
| `OptionChainSnapshot` | Option chain data | ✅ Dropped |
| `option_chain_strike` | Option chain data | ✅ Dropped |
| `fno_universe_snapshot` | F&O universe | ✅ Dropped |
| `fno_universe_entry` | F&O universe | ✅ Dropped |
| `instrument_master_snapshot` | Instrument master | ✅ Dropped |
| `instrument_master_entry` | Instrument master | ✅ Dropped |

**Total removed: 18 tables**

## Schema Consistency Check

| Check | Result |
|-------|--------|
| Prisma schema valid | ✅ PASS |
| No market-data models in schema.prisma | ✅ PASS |
| Migration history consistent | ✅ PASS (22 migrations, ordered) |
| No orphaned models | ✅ PASS |
| All FK relations valid | ✅ PASS |

## Conclusion

AlphaForge's database contains zero market-data tables. All 18 dropped tables are confirmed absent from the schema. The 17 remaining tables are all legitimate business/signal/user data tables.
