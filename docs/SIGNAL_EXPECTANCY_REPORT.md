# AlphaForge — Signal Expectancy Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## 1. Expected Value Framework

The ExpectedValueEngine (`lib/opportunity-engine/expected-value-engine.ts`) computes a complete cost-aware expected value for every opportunity.

### 1.1 Core Formula

```
Net EV = P(win) × E[win%] - P(loss) × E[loss%] - Total Costs

Where:
  P(win)      = calibrateWinProbability(rawConfidence, strategyId)
  E[win%]     = rewardPct × targetCaptureRate × maxWinPct
  E[loss%]    = riskPct (stop always honored)
  Total Costs = regulatory costs + spread + slippage
```

### 1.2 Probability Calibration (per strategy)

| Strategy | Shrinkage | Base Win Rate | Max P(win) |
|----------|-----------|---------------|------------|
| RANGE_EXPANSION | 65% | 52% | 82% |
| MOMENTUM | 60% | 50% | 82% |
| VOLUME_BREAKOUT | 65% | 51% | 82% |
| OPENING_BREAKOUT | 70% | 54% | 82% |
| OI_BUILDUP | 60% | 50% | 82% |
| PCR_EXTREME | 55% | 48% | 82% |
| IV_SPIKE | 55% | 48% | 82% |
| INDIA_AI_SIGNALS | 62% | 52% | 82% |

**Note:** These are conservative priors. Once ≥ 50 OOS trades are resolved per strategy, per-strategy calibration curves replace these values.

### 1.3 Cost Model (NSE F&O Options)

| Component | Rate | Annual Impact (100 trades) |
|-----------|------|--------------------------|
| Brokerage (₹40 RT / ₹20k notional) | ~0.20% | −20% |
| STT (0.0125%) | 0.0125% | −1.25% |
| Exchange charges (0.053%) | 0.053% | −5.3% |
| GST (18% on above) | ~0.02% | −2% |
| SEBI (0.0001%) | 0.0002% | −0.02% |
| Stamp duty (0.003%) | 0.003% | −0.3% |
| Spread (0.06% RT) | 0.06% | −6% |
| Slippage (0.05%) | 0.05% | −5% |
| **Total round-trip** | **~0.40%** | **−40%** |

A strategy with 50% win rate, 1.5R reward, 1R risk has:
- Gross EV: 0.5 × 1.5R − 0.5 × 1R = +0.25R
- After costs (0.40% of notional ≈ 0.2R): Net EV ≈ +0.05R
- Very thin margin — needs high confidence or tight stops

---

## 2. EV by Quality Tier (Theoretical Priors)

| Quality Tier | Min Net EV | Typical Net EV Range | Min R:R |
|--------------|-----------|---------------------|---------|
| A+ | > 0.5% | 0.5–2.0% | 2.0:1 |
| A | > 0.2% | 0.2–1.0% | 1.8:1 |
| B | > 0.0% | 0.0–0.5% | 1.5:1 |
| C | > -0.05% | Borderline | 1.3:1 |
| REJECT | ≤ 0% | Negative | < 1.5:1 |

---

## 3. Expectancy Curve (Target State)

The signal quality score should exhibit monotonic relationship with realized expectancy:

```
Score Bucket     Expected Win Rate     Expected Net R
90–100           58–65%                0.4–0.8R
80–90            54–60%                0.25–0.5R
70–80            50–56%                0.1–0.3R
60–70            46–52%                0–0.2R
50–60            42–50%                -0.1–0.1R
< 50             < 45%                 < 0R
```

**Verification required:** The `scoreBuckets` field in the calibration report will confirm or refute this relationship once ≥ 5 trades per bucket are resolved.

---

## 4. Cost Sensitivity Analysis

Every opportunity is stress-tested at 1.5×, 2×, and 3× costs:

| Cost Multiplier | Strategy Survives? | COST_FRAGILE Flag |
|----------------|-------------------|------------------|
| 1× (baseline) | Required | — |
| 1.5× | Preferred | — |
| 2× | Required for promotion | COST_FRAGILE if fails |
| 3× | Informational | — |

---

## 5. Latency Sensitivity

Each 100ms of latency adds approximately 0.01% additional slippage for liquid F&O:

| Latency | Extra Slippage | Breakeven Impact |
|---------|---------------|-----------------|
| 0ms | 0bps | Baseline |
| 100ms | 0.1bps | Minimal |
| 500ms | 0.5bps | Small |
| 1000ms | 1bps | Moderate |
| 2000ms | 2bps | Significant for thin-edge strategies |
| 5000ms | 5bps | Material degradation |

---

## 6. EV per Unit Risk Targets

| Strategy Type | Target EV/Risk | Notes |
|--------------|----------------|-------|
| Breakout | 0.15–0.25 | 3:1 expected, 50% win rate |
| Momentum | 0.10–0.20 | Trend continuation |
| Mean Reversion | 0.08–0.15 | Shorter moves, tighter stops |
| OI-driven | 0.05–0.15 | Context factor |

Kelly fraction (for reference only, never trade at full Kelly):
```
Recommended size = 0.25 × Kelly fraction × capital
```

---

## 7. Strategy Expectancy Benchmarks

Based on historical paper-trade data across 170+ India F&O instruments:

| Metric | Target | Current Baseline |
|--------|--------|-----------------|
| Overall win rate | 50–55% | Unknown (paper trades active) |
| Average R per trade | 0.1–0.3R | Unknown |
| Profit factor | 1.2–1.5 | Unknown |
| Net expectancy (after costs) | 0.05–0.2% per trade | Unknown |
| Sharpe (annualised) | 0.8–1.5 | Unknown |

**Note:** Historical data exists in `PaperTrade` and `IndiaDaySession` tables. Full expectancy calculation requires populating the attribution API.
