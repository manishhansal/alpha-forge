# AlphaForge — Signal Quality Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1  
**Status:** Post-implementation assessment

---

## 1. Signal Quality Architecture

The signal quality system has been upgraded from a single opaque confidence score to a multi-dimensional `SignalQualityVector` with 17 independently measurable components.

### 1.1 Quality Vector Components

| Component | Range | Description | Baseline Coverage |
|-----------|-------|-------------|------------------|
| structureScore | [0,1] | Market structure (BOS, CHoCH, FVG, swing H/L) | ✅ Implemented |
| momentumScore | [0,1] | RSI, ADX, EMA slope, momentum state | ✅ Implemented |
| volumeScore | [0,1] | RVOL, time-normalized, acceleration | ✅ Implemented |
| volatilityScore | [0,1] | ATR percentile, regime fit | ✅ Implemented |
| liquidityScore | [0,1] | Spread, depth, RVOL gate | ✅ Implemented |
| marketContextScore | [-1,1] | NIFTY/BANKNIFTY alignment | ✅ Implemented |
| regimeScore | [0,1] | Strategy×Regime compatibility matrix | ✅ Implemented |
| oiScore | [-1,1] | OI buildup classification | ✅ Implemented |
| optionsScore | [-1,1] | PCR, IV, max-pain flow | ✅ Implemented |
| relativeStrengthScore | [-1,1] | Stock vs NIFTY vs sector | ✅ Implemented |
| sectorScore | [-1,1] | Sector trend, breadth, RS | ✅ Implemented |
| mlScore | [0,1] | ML model probability (calibrated) | ✅ Implemented |
| executionScore | [0,1] | Time-of-day, spread, latency | ✅ Implemented |
| qualityScore | [0,1] | Weighted composite | ✅ Implemented |
| probabilityWin | [0,1] | Calibrated win probability | ✅ Implemented |
| netExpectedValue | unbounded | EV after all 7 costs | ✅ Implemented |
| finalScore | [0,100] | Risk-adjusted ranking metric | ✅ Implemented |

### 1.2 Quality Tier Grading

| Tier | Net EV | Quality Score | Liquidity | Additional Requirements |
|------|--------|---------------|-----------|------------------------|
| A+ | > 0.5% | > 0.75 | > 0.70 | No hard rejections, positive regime |
| A | > 0.2% | > 0.65 | > 0.55 | — |
| B | > 0.0% | > 0.50 | > 0.40 | — |
| C | > -0.05% | > 0.40 | — | Research/watch only |
| D | > 0% | > 0.30 | — | Minimal |
| REJECT | ≤ 0 OR any hard gate | ≤ 0.40 | < 0.25 | Hard gate triggered |

Thresholds are conservative priors pending calibration data from ≥ 50 resolved paper trades per strategy.

---

## 2. Transaction Cost Model

All net EV calculations include:

| Cost Component | Rate | Notes |
|----------------|------|-------|
| Brokerage | ₹40/RT (₹20 buy + ₹20 sell) | Zerodha flat |
| STT | 0.0125% on options buy premium | NSE F&O |
| Exchange charges | 0.053% options / 0.002% futures | Both sides |
| GST | 18% on brokerage + exchange | — |
| SEBI | 0.0001% on turnover | Both sides |
| Stamp duty | 0.003% buy side | — |
| Spread | 0.06% round-trip (3bps/side) | Liquid F&O |
| Slippage | 0.05% baseline | Market impact + latency |

**Total baseline cost:** ~0.20–0.35% round-trip depending on position size and notional.

---

## 3. Probability Calibration Status

| Component | Status | Notes |
|-----------|--------|-------|
| Calibration bins (10) | ✅ Implemented | Per-strategy |
| Brier score | ✅ Implemented | Target < 0.25 |
| Expected Calibration Error | ✅ Implemented | Target < 0.07 |
| Score monotonicity | ✅ Implemented | Higher score → higher WR |
| Platt scaling | 🔶 Framework ready | Needs ≥ 50 OOS trades |
| Isotonic regression | 🔶 Framework ready | Needs ≥ 100 OOS trades |
| Reliability curves | ✅ Implemented | Displayed in calibration API |

**Current status:** Conservative prior calibration (35% shrinkage toward base rate of 50%) applied universally. Per-strategy calibration will be activated automatically once sufficient OOS paper-trade data accumulates.

---

## 4. Score Monotonicity

Expected relationship:

```
Score bucket 90–100 → higher realized win rate than 70–80 → higher than 50–60
```

This is the primary test of whether the quality score is useful. Currently unverifiable due to insufficient resolved paper trades with the new scoring system.

**Automated test:** `GET /api/in/opportunity-engine/calibration` returns `scoreBuckets` with `isMonotonicWithPrev` flag per bucket. When ≥ 5 trades exist per bucket, monotonicity is evaluated automatically.

---

## 5. Signal Source Quality by Tier

| Signal Source | Expected Tier Distribution | Notes |
|---------------|---------------------------|-------|
| INDIA_AI_SIGNALS (S/A grade) | A+ / A | High-confluence, ML-boosted |
| OPENING_BREAKOUT | A / B | Best in 09:15–10:00 window |
| VOLUME_BREAKOUT | A / B | Requires RVOL > 1.5× |
| MOMENTUM | B / C | Regime-dependent |
| RANGE_EXPANSION | B / C | Weak in range regimes |
| PCR_EXTREME | B / C | Better in range regimes |
| OI_BUILDUP | B / C | Confirm with price |
| IV_SPIKE | C | High uncertainty |
| LIQUIDITY_EDGE | B | Options-derived |
| MAX_PAIN_GRAVITY | C | Contextual only |

---

## 6. API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/in/opportunity-engine` | Ranked opportunity list with quality vectors |
| `GET /api/in/opportunity-engine/regime` | Current regime + strategy compatibility matrix |
| `GET /api/in/opportunity-engine/calibration` | Probability calibration per strategy |
| `GET /api/in/opportunity-engine/attribution` | Performance attribution breakdown |
| `GET /api/in/signal-quality` | Existing signal quality report (legacy) |
| `GET /api/in/signal-audit` | Today's signal audit |
