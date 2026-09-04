# AlphaForge — India Signal False Positive Analysis
**Date:** 2026-09-03  
**Status:** NOT_TESTED — requires live session data

---

## False Positive Definition

A signal is a false positive when it:
- Hit SL before any target
- Reversed immediately after entry (within 3 bars)
- Produced negative R (< -0.5R)
- Had poor data quality at generation time (score < 70)
- Was generated during regime misclassification
- Was generated during low liquidity (pre-market, EOD)
- Had stale provider data
- Had provider disagreement > threshold
- Was a duplicate across timeframes (DUP-001)

---

## False Positive Categories

### Category 1: Data Quality False Positives

Signals generated on poor data that should have been blocked by DataQualityGate.

**Root Cause:** DataQualityGate (`POST /data/gate`) is implemented in Python but NOT called by the TypeScript signal engine (GATE-001). This means signals can be generated on:
- Stale quotes (>10s old during market hours)
- Incomplete data (missing OI when OI-based strategy)
- Provider-degraded data (circuit breaker open)

**Expected False Positive Rate from Data Quality:** 5–15% of signals  
**Fix:** Wire `gate-client.ts` → `POST /data/gate` before signal generation

### Category 2: Regime Misclassification False Positives

Signals generated when regime classifier produces wrong regime.

**Example:** ORB (Opening Breakout) signal in RANGE_BOUND regime → false positive.

**Expected Rate:** 10–20% of signals during transitions  
**Fix:** Regime classifier confidence threshold enforcement

### Category 3: Cross-Timeframe Duplicates (DUP-001)

FIXED in this release via `existingOpenAnyTf` guard in `paper-trader.ts`.

**Before fix:** Same signal generated 3× (1m + 5m + 15m) → 3 trades, 2 were false duplicates  
**After fix:** Cross-timeframe guard prevents duplicate paper trades

### Category 4: Low Liquidity False Positives

Signals generated near market open (09:15–09:20) or close (15:15–15:30) with wide spreads.

**Expected Rate:** 15% of scalper signals  
**Fix:** Time filter already exists (`triggeredAt` checks in paper-trader)

### Category 5: Provider Disagreement False Positives

Signals where Angel One and Upstox disagree by more than threshold on price.

**Detection:** `comparePrices()` in `reconciliation.service.ts`  
**Threshold:** Index 0.10%, Stock 0.50%  
**Expected Rate:** < 2% of signals on normal days

---

## Analysis for 2026-09-03 — NOT_TESTED

| FP Category | Count | % of Signals | Reason |
|------------|-------|-------------|--------|
| Data quality blocked | NOT_TESTED | — | Requires live data |
| Regime misclassification | NOT_TESTED | — | Requires live data |
| Cross-timeframe duplicates | NOT_TESTED | — | Requires live data |
| Low liquidity | NOT_TESTED | — | Requires live data |
| Provider disagreement | NOT_TESTED | — | Requires live data |
| **Total FP** | **NOT_TESTED** | — | — |

---

## Structural Improvements Applied

| Issue | Fix Applied | Status |
|-------|------------|--------|
| DUP-001 cross-timeframe inflation | `existingOpenAnyTf` guard | FIXED |
| Cross-family duplication | OpportunityCluster aggregator | FIXED |
| NSE stale data causing false signals | NSE provider removed | FIXED |
| No signal family attribution | `sourceAttribution` mandatory | FIXED |

---

*Report to be updated with live data from production session.*
