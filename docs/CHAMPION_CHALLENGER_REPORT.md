# AlphaForge — Champion / Challenger Report

**Generated:** 2026-09-02  
**Engine Version:** opportunity-engine-v1

---

## 1. Framework Overview

The Champion/Challenger framework prevents overfitting by requiring any new strategy configuration (Challenger) to demonstrate out-of-sample superiority before replacing the existing production configuration (Champion).

**Core rule:** Champion is never replaced because Challenger performed better in-sample.

**Implementation:** `lib/opportunity-engine/strategy-condition-profiler.ts` → `evaluateChampionChallenger()`

---

## 2. Promotion Requirements

For a Challenger to promote to Champion:

| Gate | Threshold | Rationale |
|------|-----------|-----------|
| Minimum trades | ≥ 30 OOS | Statistical significance |
| OOS improvement | ≥ 10% better expectancy | Meaningful gain, not noise |
| No significant drawdown increase | < 20% worse max DD | Risk control |
| Explicit human approval | Required for LIVE | Never auto-promote to live |

---

## 3. Current Champion/Challenger Status

| Strategy | Champion | Status | Challenger |
|----------|----------|--------|-----------|
| INDIA_AI_SIGNALS | v2.0.0 (SHADOW) | CHAMPION_ONLY | None |
| RANGE_EXPANSION | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| VOLUME_BREAKOUT | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| OPENING_BREAKOUT | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| MOMENTUM | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| OI_BUILDUP | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| PCR_EXTREME | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| IV_SPIKE | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| LIQUIDITY_EDGE | v1.0 (RESEARCH) | CHAMPION_ONLY | None |
| MAX_PAIN_GRAVITY | v1.0 (RESEARCH) | CHAMPION_ONLY | None |

All strategies are at RESEARCH status. No promotions have occurred.

---

## 4. Protected Baseline Rule

The opportunity engine has a `PROTECTED_BASELINE` mode for the current 14-factor India AI signals pipeline:

- The existing `getIndiaAiSignals()` pipeline continues to run unchanged
- The new opportunity pipeline runs ALONGSIDE it (not replacing it)
- Both can be compared against each other
- Only if the opportunity pipeline demonstrates material OOS improvement will it replace the legacy path

---

## 5. Experiment Registry

Every experiment (strategy configuration change) must be tracked with:

```typescript
{
  experimentId: string,
  strategyId: string,
  configHash: string,         // SHA-256 of all configuration
  featureVersion: string,
  modelVersion: string,
  datasetVersion: string,
  trainPeriod: DateRange,
  validationPeriod: DateRange,
  testPeriod: DateRange,
  hypotheses: string[],
  results: PerformanceMetrics,
  decision: "PROMOTE" | "REJECT" | "INCONCLUSIVE"
}
```

**Current experiment registry:** Empty (no experiments run yet).  
**Framework location:** `lib/research/experiments/`

---

## 6. Three-Way System Comparison (Target State)

As per the specification, three systems should be compared:

| System | Description | Status |
|--------|-------------|--------|
| A — Baseline | Current 14-factor AI pipeline, fixed ₹20k sizing, no hard gates | ✅ Running |
| B — Quality Filter | System A + opportunity pipeline hard gates + EV rejection | 🔶 Wired (ENABLE_OPPORTUNITY_PIPELINE=true) |
| C — Optimized | Full pipeline + quality-adjusted sizing + regime conditioning | 🔶 Wired (active when pipeline enabled) |

The comparison table (Section 102 of the specification) will be populated once sufficient paper trade history is accumulated under both pipeline modes.

---

## 7. Anti-Overfitting Controls

Implemented in the research platform:

| Control | Location | Status |
|---------|----------|--------|
| Deflated Sharpe Ratio | `lib/research/overfitting/` | 🔶 Defined |
| Probability of Backtest Overfitting (PBO) | `lib/research/overfitting/` | 🔶 Defined |
| Benjamini-Hochberg FDR | `lib/research/overfitting/` | 🔶 Defined |
| Bonferroni correction | `lib/research/overfitting/` | 🔶 Defined |
| Monte Carlo bootstrap | `lib/research/montecarlo/` | 🔶 Defined |
| Parameter stability | `lib/research/parameters/` | 🔶 Defined |

None have been run — no strategy has generated sufficient data for overfitting analysis.
