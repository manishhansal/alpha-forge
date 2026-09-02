# AlphaForge — Signal Rejection Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## 1. Hard Rejection Codes

The following hard rejection codes are implemented in `lib/opportunity-engine/hard-gate-engine.ts`. Each code represents an unconditional block that cannot be overridden by signal quality or confidence.

| Code | Trigger Condition | Configurable Threshold |
|------|------------------|----------------------|
| STALE_MARKET_DATA | Data age > 5 minutes | `maxDataAgeMs` |
| INVALID_OHLC | high < low or close out of range | — |
| MISSING_REQUIRED_PRICE | entry, stop, or target ≤ 0 | — |
| ZERO_LIQUIDITY | volume < 15% of 20d average | `minVolumeRatio` |
| INVALID_RISK_PARAMS | Stop loss > 4% from entry | `maxStopLossPct` |
| RR_BELOW_MINIMUM | R:R < 1.5:1 | `minRiskReward` |
| NEGATIVE_EXPECTED_VALUE | Net EV ≤ 0% after all costs | `minNetEV` |
| EXCESSIVE_SPREAD | Bid/ask spread > 0.50% | `maxSpreadPct` |
| DAILY_LOSS_LIMIT_BREACHED | Daily P&L < -3% of capital | `dailyLossLimitPct` |
| PORTFOLIO_EXPOSURE_EXCEEDED | Portfolio > 85% deployed OR open risk > 8% | `maxPortfolioExposurePct`, `maxOpenRiskPct` |
| CORRELATION_LIMIT_EXCEEDED | New trade > 80% correlated with existing | `maxPairwiseCorrelation` |
| MARKET_CLOSED | NSE outside 09:15–15:30 IST | `enforceMarketHours` |
| EXECUTION_IMPOSSIBLE | Instrument not in active F&O universe | — |
| CRITICAL_DATA_CORRUPTION | Provider returned invalid/impossible data | — |
| DRAWDOWN_HALT | Portfolio drawdown ≥ 20% | — |
| KILL_SWITCH_ACTIVE | Manual or auto kill switch | — |
| EXPIRY_GAMMA_RISK | Expiry-day gamma risk too high | — |
| INSTRUMENT_SUSPENDED | Circuit breaker or trading halt | — |
| DUPLICATE_OPPORTUNITY | Same instrument already has active opportunity | — |
| LOW_EXPECTANCY | Historical expectancy below minimum | — |
| INSUFFICIENT_SAMPLE | < 20 resolved trades for strategy | — |
| MODEL_UNAVAILABLE | ML required but not available | `requireMLWhenConfigured` |

---

## 2. Soft Penalty Codes

These reduce the quality score but do NOT block the trade. They influence ranking and sizing.

| Code | Score Reduction | Trigger |
|------|----------------|---------|
| REGIME_CONFLICT | −0.20 | Strategy edge multiplier < 0.8 in current regime |
| SECTOR_CONFLICT | −0.12 | Sector trend contradicts direction |
| MARKET_CONFLICT | −0.10 | Broad market direction conflicts |
| OI_CONFLICT | −0.08 | OI positioning contradicts direction |
| OPTION_FLOW_CONFLICT | −0.07 | Options flow contradicts direction |
| VOLATILITY_TOO_HIGH | −0.15 | ATR > 90th percentile |
| LATE_ENTRY | −0.10 | > 0.5× ATR from trigger level |
| SIGNAL_EXPIRED | −0.25 | Signal age beyond validity window |
| ML_UNCERTAINTY | −0.08 | ML probability < 0.40 |
| LOW_VOLUME | −0.10 | RVOL < 0.5× |
| WEAK_STRUCTURE | −0.08 | Detection strength < 0.5 |
| WEAK_MOMENTUM | −0.06 | Momentum not confirmed |
| HIGH_SLIPPAGE_RISK | −0.08 | Spread > 0.20% |
| POOR_TIME_OF_DAY | −0.05 to −0.15 | CAUTION or AVOID window |
| CONFLICTING_TIMEFRAMES | −0.12 | MTF alignment = CONFLICTING |
| MIXED_SECTOR_BREADTH | −0.05 | Sector breadth 35–65% |
| HIGH_CORRELATION_PENALTY | −0.07 | ≥ 2 correlated open positions |

**Maximum total soft penalty:** 60% score reduction.

---

## 3. Decision Outcomes

| Decision | Condition | Next Action |
|----------|-----------|------------|
| STRONG_BUY | A+ tier, all gates pass | Open trade at recommended size |
| BUY | A or B tier, all gates pass | Open trade |
| WATCH | C tier or MTF conflict | Monitor only |
| WAIT | Conflicting signals | Do not trade, re-evaluate next tick |
| ABSTAIN | D tier or insufficient edge | Valid no-trade decision |
| REJECT | Hard gate triggered | Log with rejection code |

---

## 4. Gate Configuration

All thresholds are configurable in `DEFAULT_HARD_GATE_CONFIG`:

```typescript
{
  maxDataAgeMs: 5 * 60 * 1000,     // 5 minutes
  minRiskReward: 1.5,               // minimum 1.5:1 R:R
  maxSpreadPct: 0.50,               // 50bps max spread
  minNetEV: 0,                      // EV must be non-negative
  maxPortfolioExposurePct: 85,      // 85% max deployed
  maxPairwiseCorrelation: 0.80,     // 80% max correlation
  dailyLossLimitPct: 3.0,          // 3% daily loss limit
  maxOpenRiskPct: 8.0,              // 8% total open risk
  maxStopLossPct: 4.0,             // 4% max SL from entry
  minVolumeRatio: 0.15,            // 15% of avg volume min
  enforceMarketHours: true,
  requireMLWhenConfigured: false,
}
```

---

## 5. Rejection Quality Measurement

The counterfactual engine (`lib/opportunity-engine/counterfactual-engine.ts`) tracks rejected opportunities and evaluates their subsequent outcomes to compute:

**False Rejection Rate:** Rejected opportunities that would have been profitable trades.  
**True Rejection Rate:** Rejected opportunities that would have been losing trades.

### Filter Performance Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| False Rejection Rate | Rejected-and-would-won / Total Rejected | < 25% |
| True Rejection Rate | Rejected-and-would-lost / Total Rejected | > 60% |
| Net Filter Value | Saved losses − Missed gains | > 0 |

**Current status:** Counterfactual tracking infrastructure is in place. Historical data needed for first report.

---

## 6. Abstention Engine

`NO_TRADE` is a valid first-class outcome. The system should abstain when:

1. Edge is insufficient (net EV ≤ 0)
2. Signals conflict (major timeframes disagree)
3. Regime is unknown or adverse
4. Volatility is extreme
5. Liquidity is poor
6. Expected costs consume the edge
7. Probability is poorly calibrated (ECE > 0.15)
8. Portfolio already has similar exposure
9. Opportunity is too late (signal expired)
10. Reward/risk is inadequate
11. Data freshness is questionable

A day with zero trades is a better outcome than a day with five low-quality trades.
