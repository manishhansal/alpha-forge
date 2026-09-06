# AlphaForge — India Data Coverage Report
**Date:** 2026-09-03  
**Status:** NOT_TESTED — requires broker credentials

---

## Coverage Framework

### Universe Expected (F&O eligible instruments)

| Category | Count | Source |
|----------|-------|--------|
| Index instruments (NIFTY, BANKNIFTY, etc.) | 5 | `FNO_INDICES` constant |
| F&O equity stocks | ~160 | `FNO_STOCKS` constant |
| Option contracts (ATM ± 20 strikes × 3 expiries) | ~2,400 | Dynamic per session |
| **Total expected** | **~2,565** | — |

### Coverage Metrics (per session)

```
universe_expected      = F&O eligible instruments
universe_available     = instruments with valid quotes this session
universe_missing       = expected - available
coverage_percent       = available / expected × 100
```

### Candle Coverage by Interval

| Interval | Expected (per instrument) | Source |
|----------|--------------------------|--------|
| 1m | 375 candles (09:15–15:29) | Angel One / Upstox |
| 5m | 75 candles | Angel One / Upstox |
| 15m | 25 candles | Angel One / Upstox |
| 1d | 1 candle | Any provider |
| Option chain snapshots | Every 5 min = 75 captures | Angel One / Upstox |

---

## Today's Coverage — NOT_TESTED

| Metric | Target | Actual |
|--------|--------|--------|
| Index coverage | 100% (5/5) | NOT_TESTED |
| F&O stock coverage | ≥ 95% | NOT_TESTED |
| 1m candle coverage (NIFTY) | ≥ 99% | NOT_TESTED |
| 5m candle coverage | ≥ 98% | NOT_TESTED |
| Option chain coverage (indices) | 100% | NOT_TESTED |
| OI data coverage | ≥ 90% | NOT_TESTED |
| Live quote freshness (< 5s) | ≥ 95% | NOT_TESTED |

---

## Coverage Endpoint

Check live coverage: `GET /api/in/universe-coverage`

Response fields:
- `totalExpected` — instruments in F&O universe
- `totalAvailable` — instruments with valid data this session
- `totalScanned` — instruments signal engine evaluated
- `totalDataComplete` — instruments with full OHLCV + OI
- `coverageScore` — 0–1 composite
- `isValid` — true when coverageScore ≥ 0.85

---

## NSE Removal Coverage Impact

**Before (with NSE provider):**  
Option chain: Angel → Upstox → NSE (scraping) → error  
Coverage: ~99% (NSE was always-available fallback)

**After (NSE removed):**  
Option chain: Angel → Upstox → error  
Coverage: Depends on Angel + Upstox availability

**Risk:** If both Angel and Upstox are unconfigured, option chain coverage drops to 0%.  
**Mitigation:** Require at least one of `SMARTAPI_API_KEY` or `UPSTOX_ANALYTICS_TOKEN` in production.

---

*Report to be populated from `UniverseCoverageSnapshot` table after live session.*
