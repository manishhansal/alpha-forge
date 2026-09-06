# AlphaForge — India Signal False Negative Analysis
**Date:** 2026-09-03  
**Status:** NOT_TESTED — requires live session data

---

## False Negative Definition

A false negative is a major market move that the system DID NOT capture with a timely, actionable signal.

Per requirements: "This is as important as measuring winning signals."

---

## False Negative Categories

| Category | Description | Detection Method |
|----------|-------------|-----------------|
| `NO_SIGNAL` | No signal generated despite clear move | Post-session scan of all instruments > threshold move |
| `SIGNAL_REJECTED` | Signal generated but rejected by Opportunity Engine | `OpportunityEngine.rejectionReason` field |
| `SIGNAL_TOO_LATE` | Signal correct but operationally delayed | `generatedAt` vs actual breakout timestamp |
| `DATA_UNAVAILABLE` | Provider returned empty/null | Provider health logs |
| `DATA_QUALITY_BLOCK` | DataQualityGate blocked signal | Gate confidence score < threshold |
| `UNIVERSE_COVERAGE_GAP` | Instrument not in F&O universe | `UniverseCoverageSnapshot` |
| `STRATEGY_GAP` | No strategy designed for this setup | Manual review |
| `THRESHOLD_TOO_STRICT` | Edge existed but below entry threshold | Signal score distribution analysis |
| `REGIME_MISCLASSIFICATION` | Wrong regime prevented valid strategy | Regime accuracy measurement |
| `FEATURE_FAILURE` | Indicator/feature computed incorrectly | Feature audit |
| `ML_FAILURE` | ML model missed obvious pattern | ML contribution analysis |
| `EXECUTION_FAILURE` | Paper trader skipped valid approved signal | `PaperTrade` vs `SignalHistory` reconciliation |

---

## Known Structural False Negative Sources

### 1. Universe Coverage Gaps

The F&O universe in `src/lib/india/fno-symbols.ts` covers the primary F&O stocks. Instruments NOT in the universe will never generate signals.

**Check:** `GET /api/in/universe-coverage` — `coverageScore` metric  
**Expected:** ≥ 95% of top-100 F&O names covered

### 2. ADX/Volume Pre-Filter (AI Signals)

AI signals apply a quant pre-filter: ADX ≥ 18, relVol ≥ 1.1×, ATR% ≥ 0.4%.

Stocks with below-threshold ADX/volume will not generate AI signals even if they have strong setups. This is intentional (reduces noise) but creates systematic false negatives for choppy stocks that have genuine setups.

**Impact:** ~15–25% of the universe filtered out on any given day

### 3. NSE Removal — Expected Impact

Before: NSE option chain was available as a fallback (priority 3)  
After: NSE removed. Option chain falls back from Angel → Upstox → (nothing)

**If both Angel and Upstox are unconfigured**, option-chain-dependent signals (PCR, IV, OI, INDICES_SCALP daily picks) will not fire.

**Mitigation:** Configure at least one of `SMARTAPI_API_KEY` or `UPSTOX_ANALYTICS_TOKEN`.

### 4. GATE-001 — DataQualityGate Not Wired

Current: TypeScript signal engine does NOT call `POST /data/gate` before generating signals.

**Impact on false negatives:** Low (gate blocks signals, not creates them)  
**Impact on false positives:** HIGH (signals may be generated on stale/bad data)

### 5. Cross-Timeframe Window

The 30-minute deduplication window in `signal-ingest` may group a late signal with an earlier one from a different timeframe, causing the later signal to not be counted independently.

---

## Analysis for 2026-09-03 — NOT_TESTED

| Category | Count | Action Taken |
|----------|-------|-------------|
| Moves > 1% with no signal | NOT_TESTED | — |
| Moves > 2% with no signal | NOT_TESTED | — |
| Breakouts missed (volume > 2x avg) | NOT_TESTED | — |
| Large OI build-up without signal | NOT_TESTED | — |
| Index moves > 0.5% without signal | NOT_TESTED | — |
| Signals blocked by data quality | NOT_TESTED | — |
| Signals blocked by regime | NOT_TESTED | — |
| Universe gaps | NOT_TESTED | — |

---

## Recommendations

1. After any significant market move (>2%), check `UniverseCoverageSnapshot` to see if the instrument was tracked
2. Check `SignalHistory` for rejected signals on that instrument (was it generated but rejected?)
3. Check `OpportunityEngine` attribution logs for skip reasons
4. Compare `IndiaDaySession.missedOpportunities` vs actual movers

*Report to be updated with live data from production session.*
