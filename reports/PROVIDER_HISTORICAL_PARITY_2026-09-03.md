# AlphaForge — Provider Historical Data Parity Report
**Date:** 2026-09-03  
**Session:** Post-market close validation  
**Status:** NOT_TESTED (requires live broker credentials)

---

## Executive Summary

Historical data parity between Angel One, Upstox, and Yahoo Finance cannot be validated without active broker credentials (`SMARTAPI_API_KEY` and `UPSTOX_ANALYTICS_TOKEN`). This report documents:

1. What was architecturally designed for parity validation
2. What was NOT_TESTED and why
3. Framework for running this validation when credentials are available
4. Known structural differences between providers

---

## Why NOT_TESTED

| Requirement | Status | Reason |
|-------------|--------|--------|
| Angel One live data | NOT_TESTED | `SMARTAPI_API_KEY` not configured in this environment |
| Upstox live data | NOT_TESTED | `UPSTOX_ANALYTICS_TOKEN` not configured |
| Yahoo Finance | PASS | No credentials needed — baseline available |
| Cross-provider comparison | BLOCKED | Cannot compare without ≥2 providers |

Per the project requirements (Phase 3 principle): "If an external provider is unavailable: report unavailable, record exact reason, mark validation as NOT_TESTED where appropriate. Never manufacture today's prices."

---

## Parity Framework (Designed, Not Yet Executed)

### Test Universe

When credentials are available, run parity validation against:

#### Indices
| Symbol | Angel One Key | Upstox Key | Yahoo Symbol |
|--------|--------------|------------|--------------|
| NIFTY 50 | Token: 99926000 | `NSE_INDEX|Nifty 50` | `^NSEI` |
| BANKNIFTY | Token: 99926009 | `NSE_INDEX|Nifty Bank` | `^NSEBANK` |
| FINNIFTY | Token: 99926037 | `NSE_INDEX|Nifty Fin Service` | `^CNXFIN` |
| MIDCPNIFTY | Token: 99926074 | `NSE_INDEX|Nifty MidCap Select` | N/A |
| INDIA VIX | Token: 99926017 | `NSE_INDEX|India VIX` | N/A |

#### F&O Equity Universe (representative sample)
| Symbol | Type | Expected Parity |
|--------|------|----------------|
| RELIANCE | FUTSTK | OHLCV within 0.1% |
| HDFCBANK | EQ | OHLCV within 0.5% |
| ICICIBANK | EQ | OHLCV within 0.5% |
| TCS | EQ | OHLCV within 0.5% |
| INFY | EQ | OHLCV within 0.5% |
| BAJFINANCE | OPTSTK | OI comparison |
| NIFTY24SEP24000CE | OPTIDX | OI, IV, LTP comparison |
| NIFTY24SEP24000PE | OPTIDX | OI, IV, LTP comparison |

### Comparison Metrics

For each instrument and interval (1m, 5m, 15m, 1d):

```
candle_count_angel
candle_count_upstox
candle_count_yahoo

missing_candles_angel
missing_candles_upstox

ohlc_mean_absolute_diff (%)
ohlc_max_diff (%)
volume_diff (%)
timestamp_alignment_errors

agreement_classification:
  AGREEMENT            — diff < threshold for category
  MINOR_VARIANCE       — diff within 2x threshold
  SIGNIFICANT_VARIANCE — diff within 5x threshold
  CONFLICT             — diff exceeds 5x threshold
  UNAVAILABLE          — provider didn't return data
  STALE                — timestamp > freshness threshold
```

### Known Structural Differences

These are EXPECTED differences that should NOT be classified as conflicts:

| Aspect | Angel One | Upstox | Yahoo | Note |
|--------|-----------|--------|-------|------|
| OI data | ✓ (futures/options) | ✓ | ✗ | Yahoo has no OI |
| OI change | ✓ | ✓ | ✗ | Yahoo has no OI change |
| Greeks (IV, delta, etc.) | ✓ | ✓ | ✗ | |
| Quote delay | Real-time | Real-time | ~15min | Yahoo is NOT for live trading |
| Historical depth | 1-2 years (1m) | 1-2 years (1m) | 5+ years (1d) | Yahoo good for long-term equity research |
| F&O instruments | ✓ | ✓ | ✗ | Yahoo doesn't cover NFO |
| Lot sizes | From ScripMaster | From instrument key | ✗ | |
| Expiry strings | DD-MMM-YYYY | YYYY-MM-DD | ✗ | Normalised by normalizeExpiry() |

### Corporate Action Handling

Yahoo Finance adjusts historical OHLC for corporate actions (splits, dividends) by default. Angel One and Upstox typically provide unadjusted data unless specifically requested. This creates expected differences in pre-event historical bars — NOT a provider disagreement.

---

## Parity Test Script (Executable When Credentials Available)

```typescript
// Run this with: SMARTAPI_API_KEY=... UPSTOX_ANALYTICS_TOKEN=... ts-node scripts/parity-check.ts

async function runParityCheck(symbol: string, interval: string) {
  const [angelCandles, upstoxCandles, yahooCandles] = await Promise.allSettled([
    registry.getHistoricalCandles({ symbol, exchange: 'NSE', interval, from: '2026-09-02', to: '2026-09-03' }),
    registry.getHistoricalCandles({ symbol, exchange: 'NSE', interval, from: '2026-09-02', to: '2026-09-03' }),
    registry.getHistoricalCandles({ symbol, exchange: 'NSE', interval, from: '2026-09-02', to: '2026-09-03' }),
  ]);
  // Compare...
}
```

---

## Today's Session (2026-09-03) — NOT_TESTED

Since broker credentials are not configured in this environment:

| Metric | Angel One | Upstox | Yahoo |
|--------|-----------|--------|-------|
| NIFTY close | NOT_TESTED | NOT_TESTED | NOT_TESTED |
| BANKNIFTY close | NOT_TESTED | NOT_TESTED | NOT_TESTED |
| NIFTY 1m candle count | NOT_TESTED | NOT_TESTED | NOT_TESTED |
| Provider agreement | BLOCKED | BLOCKED | N/A |

---

## Recommendation

1. Configure `SMARTAPI_API_KEY` + `UPSTOX_ANALYTICS_TOKEN` in production
2. Run `scripts/run-parity-check.ts` (to be created) daily after market close
3. Store results in `reports/parity/YYYY-MM-DD.json` for trend analysis
4. Alert if OHLC divergence > 1% for indices or > 2% for stocks on same timestamp

**This report will be updated once credentials are available.**
