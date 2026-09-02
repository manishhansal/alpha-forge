# AlphaForge — Strategy × Regime Matrix

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## Overview

The Strategy × Regime Matrix defines expected edge multipliers for each strategy in each market regime. An edge multiplier of 1.0 means the strategy is expected to perform at its historical average. Values > 1.0 indicate enhanced edge; values < 1.0 indicate reduced edge.

**Source:** `lib/opportunity-engine/market-regime-engine.ts` → `STRATEGY_REGIME_MATRIX`

**Status:** Conservative priors pending OOS validation. All values are hypotheses, not measured performance.

---

## Matrix (Edge Multipliers)

| Strategy | STRONG_BULL | WEAK_BULL | RANGE | HIGH_VOL_RANGE | STRONG_BEAR | WEAK_BEAR | PANIC | TRANSITION | UNKNOWN |
|----------|-------------|-----------|-------|----------------|-------------|-----------|-------|------------|---------|
| RANGE_EXPANSION | 1.40 | 1.10 | 0.50 | 0.70 | 1.30 | 1.00 | 0.40 | 0.70 | 0.60 |
| VOLUME_BREAKOUT | 1.50 | 1.20 | 0.40 | 0.60 | 1.40 | 1.10 | 0.30 | 0.60 | 0.50 |
| OPENING_BREAKOUT | 1.50 | 1.20 | 0.60 | 0.80 | 1.40 | 1.00 | 0.50 | 0.80 | 0.70 |
| MOMENTUM | 1.60 | 1.20 | 0.30 | 0.50 | 1.50 | 1.00 | 0.40 | 0.50 | 0.50 |
| PCR_EXTREME | 0.50 | 0.80 | 1.50 | 1.30 | 0.50 | 0.90 | 0.60 | 1.00 | 0.70 |
| IV_SPIKE | 0.60 | 0.80 | 1.20 | 1.60 | 0.70 | 0.90 | 1.40 | 1.10 | 0.80 |
| LIQUIDITY_EDGE | 0.80 | 1.00 | 1.40 | 1.20 | 0.80 | 1.00 | 0.50 | 0.90 | 0.70 |
| MAX_PAIN_GRAVITY | 0.50 | 0.70 | 1.60 | 0.80 | 0.50 | 0.70 | 0.30 | 0.80 | 0.60 |
| OI_BUILDUP | 1.40 | 1.10 | 0.80 | 0.70 | 1.40 | 1.00 | 0.50 | 0.70 | 0.60 |
| INDIA_AI_SIGNALS | 1.30 | 1.10 | 0.80 | 0.70 | 1.20 | 1.00 | 0.40 | 0.70 | 0.50 |

---

## Regime Definitions

| Regime | Classification Criteria |
|--------|------------------------|
| STRONG_BULL_TREND | ADX > 28, NIFTY above SMA20/50/200, breadth > 55% |
| WEAK_BULL | directionScore > 0.2, ADX 20–28 or below all thresholds |
| RANGE | ADX < 20, price oscillating |
| HIGH_VOLATILITY_RANGE | ADX < 22, ATR percentile > 70th |
| STRONG_BEAR_TREND | ADX > 28, NIFTY below SMA20/50/200, breadth < 45% |
| WEAK_BEAR | directionScore < -0.2, insufficient conviction |
| PANIC | VIX ≥ 25 + NIFTY < -2%, OR single-day move > 3.5% |
| TRANSITION | ADX > 20 but direction neutral |
| UNKNOWN | Insufficient candle data (< 20 daily bars) |

---

## Compatibility Classification

| Multiplier Range | Compatibility | Action |
|-----------------|---------------|--------|
| ≥ 1.40 | STRONGLY_SUPPORTED | Full size, no regime penalty |
| 1.00 – 1.39 | SUPPORTED | Standard size |
| 0.80 – 0.99 | NEUTRAL | Standard size, minor soft penalty |
| 0.50 – 0.79 | ADVERSE | Reduced size, REGIME_CONFLICT soft penalty (−0.20 score) |
| < 0.50 | STRONGLY_ADVERSE | Minimal size, consider abstaining |

---

## Notable Regime Insights

### Breakout strategies (RANGE_EXPANSION, VOLUME_BREAKOUT, MOMENTUM)
- **Best regime:** STRONG_BULL_TREND / STRONG_BEAR_TREND (1.4–1.6×)
- **Worst regime:** RANGE / HIGH_VOL_RANGE (0.3–0.7×)
- **Rationale:** Breakouts need directional follow-through. Range markets produce false breakouts.

### Mean-reversion / options strategies (PCR_EXTREME, MAX_PAIN_GRAVITY)
- **Best regime:** RANGE / HIGH_VOL_RANGE (1.2–1.6×)
- **Worst regime:** STRONG_BULL / STRONG_BEAR (0.5×)
- **Rationale:** Options strategies profit from mean-reversion, which requires bounded price action.

### IV strategies (IV_SPIKE)
- **Best regime:** HIGH_VOLATILITY_RANGE / PANIC (1.4–1.6×)
- **Worst regime:** STRONG_BULL (0.6×)
- **Rationale:** IV crush opportunities arise in elevated vol environments.

### Opening Breakout
- **Best in all trends** (1.4–1.5×) but degrades in RANGE (0.6×) and PANIC (0.5×)
- **Most regime-robust** of the breakout strategies

---

## OOS Validation Status

| Strategy | Regime Validation Trades | Status |
|----------|--------------------------|--------|
| All strategies | 0 per regime | 🔶 Priors only |

**Required:** ≥ 20 trades per regime per strategy before the matrix values are replaced with measured performance. The matrix values above are theoretical hypotheses based on strategy design logic.

---

## Integration

The Strategy × Regime Matrix is called at pipeline stage 1 in every opportunity evaluation:

```typescript
// market-regime-engine.ts
const regimeScore = computeRegimeScore(strategyId, marketRegime);
// Returns [0, 1] where:
//   0.0 = strongly adverse (multiplier ≤ 0.3)
//   1.0 = strongly supported (multiplier ≥ 1.6)

// Regime compatibility also gates the REGIME_CONFLICT soft penalty
const strategyCompatible = regimeEval.strategyCompatibility.get(strategyId)?.compatible;
```
