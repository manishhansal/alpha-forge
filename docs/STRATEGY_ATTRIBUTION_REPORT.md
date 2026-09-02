# AlphaForge — Strategy Attribution Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## 1. Attribution Framework

The Performance Attribution Engine (`lib/opportunity-engine/performance-attribution.ts`) decomposes realized P&L into 8 components. This separates genuine alpha from risk-taking and cost drag.

### 1.1 Attribution Components

| Component | Description | Measurement |
|-----------|-------------|-------------|
| Strategy selection | Which strategies were chosen | Per-strategy win rate × contribution |
| Entry timing | How much of available move captured | MFE capture rate, entry efficiency |
| Position sizing | Did larger sizes get better trades? | size×quality correlation |
| Exit management | How well exits preserved gains | MFE capture rate vs target |
| Regime selection | Were right strategies used in right regimes? | Regime × strategy performance |
| Risk filtering | What did hard gates prevent? | Counterfactual outcomes |
| ML contribution | Did ML improve outcomes vs baseline? | ML vs non-ML win rate |
| Cost drag | P&L lost to transaction costs | Total cost % × volume |

### 1.2 API Endpoint

```
GET /api/in/opportunity-engine/attribution?days=30
```

Returns full `PerformanceAttribution` object.

---

## 2. Current Attribution Status

| Component | Data Available | Attribution Computed |
|-----------|---------------|---------------------|
| Strategy selection | ✅ PaperTrade.source | ✅ Per strategy win rate |
| Entry timing | ⚠️ No MFE/MAE tracking yet | 🔶 Partial (hold time only) |
| Position sizing | ✅ PaperTrade.notional | ✅ size×return correlation |
| Exit management | ⚠️ No MFE tracking | 🔶 Partial (exit reason) |
| Regime attribution | 🔶 Regime stored in meta after v1 | 🔶 Will populate going forward |
| Risk filtering | 🔶 Counterfactual framework ready | ❌ Not yet accumulated |
| ML contribution | 🔶 ML probability in meta when present | 🔶 Partial |
| Cost drag | ✅ Cost model in EV engine | 🔶 Estimated (0.40% RT) |

---

## 3. MFE / MAE Framework

Maximum Favorable Excursion (MFE) and Maximum Adverse Excursion (MAE) are not yet tracked in the `PaperTrade` schema. To enable full attribution:

**Schema change required** (future migration):
```sql
ALTER TABLE "PaperTrade" ADD COLUMN mfe_pct FLOAT;
ALTER TABLE "PaperTrade" ADD COLUMN mae_pct FLOAT;
ALTER TABLE "PaperTrade" ADD COLUMN time_to_mfe_min INT;
```

**Purpose:**
- MFE → optimize target placement and trailing exits
- MAE → optimize stop placement and reduce premature exits
- MFE capture rate → measure exit quality (actual gain / max gain)
- MAE-to-loss → identify stops that were too tight

---

## 4. Strategy Attribution (Live Paper Trades — Framework Ready)

Attribution by strategy requires grouping `PaperTrade` rows by the `source` column prefix and computing per-group statistics.

Current groupings available:
- `in:DAILY_PICK:1d` → Daily Picks auto-trader
- `in:AI_SIGNAL:1d` → AI Signals auto-trader
- `in:RANGE_EXPANSION:5m` → Range Expansion strategy
- `in:MOMENTUM:5m` → Momentum scanner
- `in:VOLUME_BREAKOUT:5m` → Volume Breakout scanner
- `in:OI_BUILDUP:1d` → OI Buildup scanner
- `in:PCR_EXTREME:1d` → PCR Extreme scanner
- `in:IV_SPIKE:1d` → IV Spike scanner
- `in:OPENING_BREAKOUT:5m` → Opening Breakout
- `in:LIQUIDITY_EDGE:5m` → Liquidity Edge
- `in:MAX_PAIN_GRAVITY:5m` → Max Pain Gravity

---

## 5. Counterfactual Attribution

For every hard-rejected opportunity, the system will evaluate:
- What would have happened if the trade was taken?
- Was the rejection correct (prevented a loss)?
- Was the rejection incorrect (prevented a gain)?

This directly measures the **value of each hard gate**.

API: `GET /api/in/opportunity-engine/attribution` — includes counterfactual summary once data accumulates.

---

## 6. Sizing Attribution

A key question: **Do higher-quality signals actually get larger sizes and produce better outcomes?**

Measured by:
- Pearson correlation between quality score and realized return
- Pearson correlation between position size and realized return
- Pearson correlation between position size and quality score

If quality-return correlation is near zero, the quality scoring is not producing meaningful differentiation.

---

## 7. Regime Attribution (Live, When Data Accumulates)

Once the opportunity pipeline is storing regime in trade metadata:

```
Regime              | Trades | Win Rate | Avg Return | Contribution
STRONG_BULL_TREND   |        |          |            |
WEAK_BULL           |        |          |            |
RANGE               |        |          |            |
HIGH_VOLATILITY_RANGE |      |          |            |
...
```

**Expected finding:** Bull trend should show best outcomes for breakout/momentum strategies. Range should show best outcomes for options/mean-reversion.
