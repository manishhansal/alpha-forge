# AlphaForge — India Signal Performance Report
**Date:** 2026-09-03  
**Status:** NOT_TESTED — broker credentials required for live data

---

## Non-Fabrication Statement

Per project principles: "Do NOT optimize the system to make today's result look profitable. If today's signals lose money, report that honestly."

Live signal performance for 2026-09-03 cannot be measured without:
1. Angel One / Upstox credentials for real-time 1m candles
2. A running worker process during market hours (09:15–15:30 IST)
3. Actual paper trades opened by the Opportunity Engine

No performance data is fabricated. All metrics below are `NOT_TESTED`.

---

## Performance Framework (To Be Executed in Production)

### Per-Strategy Metrics

For each strategy, these metrics would be calculated:

| Metric | Formula |
|--------|---------|
| Win Rate | `wins / (wins + losses)` |
| Expectancy | `(winRate × avgWin) - ((1-winRate) × avgLoss)` |
| R Expectancy | `(winRate × avgWinR) - ((1-winRate) × avgLossR)` |
| Profit Factor | `grossProfit / grossLoss` |
| Max Drawdown | `max(runningMax - runningEquity)` |
| MFE | Highest unrealized P&L before exit |
| MAE | Lowest unrealized P&L before exit |
| Average Hold Time | `mean(exitTime - entryTime)` |
| Signal Count | Total signals generated |
| Missed Opportunities | See false negative analysis |
| False Positives | Signals that hit SL immediately |

### Quant Quality Gate Classification

Each strategy would be classified as:

| Class | Criteria |
|-------|---------|
| `PROMISING` | Win rate > 55%, positive expectancy, ≥10 trades |
| `NEUTRAL` | Win rate 45–55%, expectancy near zero |
| `WEAK` | Win rate < 45%, or negative expectancy |
| `INSUFFICIENT_SAMPLE` | < 10 trades (today's data alone) |
| `BROKEN` | Win rate < 30%, or systematic errors detected |

**All 9 India F&O strategies are currently classified as `INSUFFICIENT_EVIDENCE`** — by design. One day's data is not sufficient evidence for strategy promotion.

---

## Transaction Cost Model

Costs applied to all Indian paper trades:

| Cost Component | Rate | Basis |
|---------------|------|-------|
| Brokerage (Zerodha/flat) | ₹20 per order | Per execution |
| STT (buy+sell equity delivery) | 0.1% | On sell leg |
| STT (F&O sell) | 0.0125% | On premium |
| Exchange charges (NSE) | 0.0035% | Both legs |
| GST on brokerage | 18% | On brokerage |
| SEBI charges | ₹10 per crore | Turnover |
| Stamp duty | 0.003% | Buy leg only |
| Slippage (est.) | 0.05% | Per leg, index futures |
| Slippage (options) | 0.5% | Per leg, wide spreads |

These are applied in `computePaperFill()` from `paper-trading-fidelity.ts`:
```
fill = mid + half_spread + market_impact + latency_drift
```

---

## Today's Results (All NOT_TESTED)

| Signal Family | Signals | Wins | Losses | Win Rate | Expectancy |
|--------------|---------|------|--------|----------|-----------|
| AI Signals | NOT_TESTED | — | — | — | — |
| Daily Picks | NOT_TESTED | — | — | — | — |
| F&O Scanners | NOT_TESTED | — | — | — | — |
| FnO Trend | NOT_TESTED | — | — | — | — |
| Scalper | NOT_TESTED | — | — | — | — |
| MSB | NOT_TESTED | — | — | — | — |
| **Total** | **NOT_TESTED** | — | — | — | — |

---

## Data Quality → Performance Correlation

The system is designed to analyze:

```
Bucket by data quality score:
  90–100: {count, winRate, expectancy}
  80–89:  {count, winRate, expectancy}
  70–79:  {count, winRate, expectancy}
  60–69:  {count, winRate, expectancy}
  <60:    {count, winRate, expectancy}
```

If signals with `dataQualityScore < 70` show materially worse performance, the DataQualityGate minimum threshold should be raised. This analysis requires production data.

---

## Market Regime → Strategy Performance

When regime classification is operational:

| Strategy | TRENDING_BULLISH | TRENDING_BEARISH | RANGE_BOUND | HIGH_VOL | LOW_VOL |
|----------|:---:|:---:|:---:|:---:|:---:|
| OPENING_BREAKOUT | EXPECTED_STRONG | EXPECTED_STRONG | EXPECTED_WEAK | NEUTRAL | NEUTRAL |
| MOMENTUM | STRONG | STRONG | WEAK | NEUTRAL | WEAK |
| RANGE_EXPANSION | WEAK | WEAK | STRONG | NEUTRAL | STRONG |
| OI_BUILDUP | STRONG | STRONG | NEUTRAL | STRONG | NEUTRAL |
| SCALPER | NEUTRAL | NEUTRAL | NEUTRAL | WEAK | STRONG |
| GAMMA_BLAST | NEUTRAL | NEUTRAL | NEUTRAL | STRONG | WEAK |

*Expected performance by regime — not validated performance.*

---

*Report generated 2026-09-03. All performance metrics NOT_TESTED. Will be populated from production data.*
