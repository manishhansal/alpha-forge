# Canonical Data Audit — AlphaForge Phase 5

> Generated: 2026-09-01  
> Auditor: Principal Quant Systems Engineer  
> Scope: All files that consume market data

---

## Architecture Overview

AlphaForge has a purpose-built provider-agnostic market data registry at `src/lib/market-data/` with the canonical priority chain:

```
External Provider (Angel One / Upstox / NSE / Yahoo)
  ↓
Provider Adapter (src/lib/market-data/providers/)
  ↓
MarketDataRegistry (registry.ts)
  ↓
Provider Health / Failover (health.ts / failover.ts)
  ↓
Normalization (normalizer.ts)
  ↓
Validation (validation/candle-validator.ts)
  ↓
Reconciliation (services/reconciliation.service.ts)
  ↓
Canonical Cache / Candle Store (cache/ + candle-builder.service.ts)
  ↓
Consumers (Strategies, Scanners, ML Features, Signals, Risk, APIs, Paper Trading)
```

**The registry exists and is correctly structured. The problem: the vast majority of India feature consumers bypass it and call legacy adapters directly.**

---

## Audit Results Table

| FILE | CURRENT DATA SOURCE | CANONICAL OR BYPASS | CRITICALITY | ACTION REQUIRED |
|------|---------------------|---------------------|-------------|-----------------|
| `src/app/api/in/nifty-bias/route.ts` | `registry.getLatestQuote()` | **CANONICAL** | LOW | None — already correct |
| `src/lib/market-data/services/historical.service.ts` | `registry.getHistoricalCandles()` | **CANONICAL** | HIGH | None — already correct |
| `src/lib/market-data/services/candle-builder.service.ts` | Receives `LiveTick` from registry `subscribe()` | **CANONICAL** | HIGH | None — already correct |
| `src/lib/market-data/services/option-chain.service.ts` | `registry.getOptionChain()` | **CANONICAL** | HIGH | None — already correct |
| `src/lib/market-data/services/reconciliation.service.ts` | Cross-provider reconciliation via registry | **CANONICAL** | MEDIUM | None — already correct |
| `src/app/api/in/top-picks/route.ts` | `new YahooFinance()` directly | **BYPASS** | HIGH | MIGRATE to `registry.getQuotes()` |
| `src/app/api/in/sector-stocks/route.ts` | `new YahooFinance()` directly | **BYPASS** | HIGH | MIGRATE to `registry.getQuotes()` |
| `src/app/api/in/option-chain/route.ts` | `nse` legacy adapter directly | **BYPASS** | HIGH | MIGRATE to `registry.getOptionChain()` |
| `src/app/api/in/feed/stream/route.ts` | `angel` legacy adapter injected | **PARTIAL** | MEDIUM | DOCUMENT exception — injection pattern is intentional |
| `src/app/api/in/portfolio/route.ts` | `angel` legacy adapter directly | **BYPASS** | MEDIUM | MIGRATE to broker factory abstraction |
| `src/features/ai-signals/india-builder.ts` | `yahoo` + `nse` + `angel` legacy adapters | **BYPASS** | **CRITICAL** | MIGRATE — this drives AI Signals + Daily Picks |
| `src/services/india/scanner/engine.ts` | `yahoo` + `nse` + `angel` legacy adapters | **BYPASS** | **CRITICAL** | MIGRATE — drives all 8 scanner types |
| `src/features/india/scalping/strategies/opening-breakout.ts` | `yahoo` + `nse` legacy adapters | **BYPASS** | HIGH | MIGRATE |
| `src/features/india/scalping/strategies/positioning.ts` | `yahoo` + `nse` legacy adapters | **BYPASS** | HIGH | MIGRATE |
| `src/features/india/scalping/backtest.ts` | `yahoo` legacy adapter | **BYPASS** | MEDIUM | MIGRATE |
| `src/features/india/scalping/paper-trader.ts` | `yahoo` legacy adapter | **BYPASS** | HIGH | MIGRATE |
| `src/features/india/scalping/option-chain-capture.ts` | `nse` + `yahoo` legacy adapters | **BYPASS** | HIGH | MIGRATE |
| `src/features/india/daily-picks/builder.ts` | Transitive via `india-builder.ts` | **BYPASS** (transitive) | CRITICAL | Fix upstream (`india-builder.ts`) |
| `src/features/india/expiry-trades/builder.ts` | `yahoo` + `nse` + `angel` legacy adapters | **BYPASS** | HIGH | MIGRATE |
| `src/features/india/fno-trend-history/service.ts` | `yahoo` legacy adapter | **BYPASS** | MEDIUM | MIGRATE |
| `worker/src/jobs/india-scalper.ts` | `yahoo` legacy adapter directly | **BYPASS** | HIGH | MIGRATE |
| `worker/src/jobs/india-daily-picks.ts` | Transitive via `india-builder.ts` | **BYPASS** (transitive) | HIGH | Fix upstream |
| `worker/src/jobs/india-scanner.ts` | Transitive via `scanner/engine.ts` | **BYPASS** (transitive) | HIGH | Fix upstream |
| `src/lib/india/ml-enhanced-context.ts` | No direct market data — uses ML features | CANONICAL | MEDIUM | None |
| `src/lib/india/ml-client.ts` | No market data — HTTP to ML service | CANONICAL | MEDIUM | None |
| `src/lib/market-data/providers/yahoo.ts` | Wraps `@/services/india/yahoo` (legitimate) | **CANONICAL** | N/A | This IS the canonical wrapper |
| `src/lib/market-data/providers/nse.ts` | Wraps `@/services/india/nse` (legitimate) | **CANONICAL** | N/A | This IS the canonical wrapper |
| `src/lib/market-data/providers/angel-one.ts` | Wraps Angel One SmartAPI (legitimate) | **CANONICAL** | N/A | This IS the canonical wrapper |
| `src/lib/market-data/providers/upstox.ts` | Wraps Upstox Analytics API (legitimate) | **CANONICAL** | N/A | This IS the canonical wrapper |
| `src/services/india/yahoo/index.ts` | `yahoo-finance2` direct (LEGACY ADAPTER) | **EXCEPTION** | N/A | Pre-registry adapter — only for use by canonical `YahooProvider` |
| `src/services/india/nse/index.ts` | `https://www.nseindia.com` direct (LEGACY ADAPTER) | **EXCEPTION** | N/A | Pre-registry adapter — only for use by canonical `NseProvider` |
| `src/services/india/angelone/index.ts` | Angel One SmartAPI (LEGACY ADAPTER) | **EXCEPTION** | N/A | Pre-registry adapter — only for use by canonical `AngelOneProvider` |

---

## Allowlisted Exceptions

The following direct uses of legacy adapters are **explicitly permitted** because they are the correct internal implementation of canonical providers, or they use the injection pattern:

| FILE | REASON |
|------|--------|
| `src/lib/market-data/providers/yahoo.ts` | Canonical registry wrapper — this IS the correct place |
| `src/lib/market-data/providers/nse.ts` | Canonical registry wrapper — this IS the correct place |
| `src/lib/market-data/providers/angel-one.ts` | Canonical registry wrapper — this IS the correct place |
| `src/lib/market-data/providers/upstox.ts` | Canonical registry wrapper — this IS the correct place |
| `src/services/india/yahoo/index.ts` | Legacy adapter implementation, not a consumer |
| `src/services/india/nse/index.ts` | Legacy adapter implementation, not a consumer |
| `src/services/india/angelone/index.ts` | Legacy adapter implementation, not a consumer |
| `src/services/india/websocket/gateway.ts` | Accepts injected `fetchQuotes`/`subscribe` callbacks — injection pattern is safe |

---

## High-Priority Migration Summary

### CRITICAL Priority (drives production trading decisions)

1. **`src/features/ai-signals/india-builder.ts`** — Drives the entire AI Signals board and Daily Picks candidate pool. Directly calls `yahoo`, `nse`, and `angel` for 170-symbol bulk quotes, 1y history, and option chains. Every signal generated here bypasses the registry's health monitoring, failover, normalization, and validation layers.

2. **`src/services/india/scanner/engine.ts`** — Drives all 8 scanner types (momentum, volume breakout, range expansion, PCR, IV spike, OI buildup, FnO bullish/bearish trend). Same bypasses as india-builder.ts.

### HIGH Priority (affects trading execution)

3. **`src/features/india/scalping/paper-trader.ts`** — Uses `yahoo.getHistorical()` for trade resolution. P&L calculations and WIN/LOSS outcomes are based on unvalidated data.

4. **`src/features/india/scalping/option-chain-capture.ts`** — Uses `nse` and `yahoo` for building historical option chain snapshots used in backtesting.

5. **`src/app/api/in/top-picks/route.ts`** — Instantiates `new YahooFinance()` directly in route handler. Bypasses even the `yahoo` adapter's caching layer.

6. **`src/app/api/in/sector-stocks/route.ts`** — Same pattern as top-picks.

7. **`worker/src/jobs/india-scalper.ts`** — Uses `yahoo` directly for indicator state refresh.

### MEDIUM Priority (affects data quality)

8. **`src/features/india/scalping/strategies/opening-breakout.ts`** — `yahoo` + `nse`
9. **`src/features/india/scalping/strategies/positioning.ts`** — `yahoo` + `nse`
10. **`src/features/india/expiry-trades/builder.ts`** — `yahoo` + `nse` + `angel`
11. **`src/features/india/fno-trend-history/service.ts`** — `yahoo`
12. **`src/features/india/scalping/backtest.ts`** — `yahoo`

---

## Forbidden Import Guard

A lint rule is enforced via `src/lib/market-data/canonical-import-guard.ts` (see Phase 2 implementation). It flags direct imports of `yahoo-finance2`, `angel` legacy adapter, `upstox` SDK, or raw NSE URLs outside of the approved provider modules.

**Approved provider modules** (the only locations that may import these):
- `src/lib/market-data/providers/`
- `src/services/india/yahoo/`
- `src/services/india/nse/`
- `src/services/india/angelone/`

Any other file importing these is a bypass violation.

---

## NSE URL Access Points

All direct `https://www.nseindia.com` HTTP requests are confined to:
- `src/services/india/nse/index.ts` — `nseFetch()` hand-rolled session warm-up

The `NseProvider` in `src/lib/market-data/providers/nse.ts` wraps this adapter, so NSE URL access is correctly isolated.

---

## WebSocket Connections to Market Providers

| Connection | File | Type | Canonical? |
|---|---|---|---|
| Angel One SmartStream (`wss://smartapisocket.angelone.in/smart-stream`) | `src/lib/market-data/providers/angel-one.ts` | Binary WS | YES — part of registry |
| Upstox WS (`wss://api.upstox.com/v2/feed/...`) | `src/lib/market-data/providers/upstox.ts` | JSON WS | YES — part of registry |
| Binance WS | `NEXT_PUBLIC_BINANCE_WS` env var | Public stream | Client-side crypto surface |
| Bybit WS | `NEXT_PUBLIC_BYBIT_WS` env var | Public stream | Client-side crypto surface |

---

## Action Plan

| Phase | Scope | Target |
|-------|-------|--------|
| Phase 2 | Canonical data access enforcement + lint guard | Prevent new bypasses |
| Phase 3 | Price Forecaster input pipeline | `PriceForecasterInputBuilder` |
| Phase 4 | ML feature quality policy | `FeatureQualityValidator` |
| Phase 9 | Atomic trade guard | Redis `SET NX EX` |
| Phase 10 | Order state machine | `TradingStateMachine` |
| Phase 11 | NSE trading calendar | `NSETradingCalendar` |
| Phase 12 | F&O data quality rules | `OptionDataQualityValidator` |
