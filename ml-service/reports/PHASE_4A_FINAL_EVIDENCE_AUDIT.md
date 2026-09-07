# PHASE 4A FINAL — Independent Real-Market Evidence Audit

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service` · **HEAD:** `705b881` (PHASE_4A)
**Date:** 2026-09-06 · **Audit type:** AUDIT-ONLY — no code, model, evidence, or configuration modified

---

## Executive summary

This independent audit determines whether Phase 4A's real-market evidence is trustworthy. The finding is unambiguous: **no real-market evidence exists.** The Phase 4A entry, baseline freeze, and safety verification are real and green, but the real-market paper-trading evidence window was never executed — independently confirmed by (a) zero evidence corpora / accumulated sessions on disk, and (b) no configured provider credentials. Critically, this absence is **honestly disclosed, not fabricated**: no synthetic sessions were dressed up as real-market evidence.

The engineering posture is strong (frozen system, clean regression, no live-order path, no secrets). The alpha posture is `INSUFFICIENT_EVIDENCE`. Both statements are simultaneously true and both are acceptable (§46).

The ML service source has been **frozen since `abbc403` (PHASE_3S)** — neither the 3T nor 4A commits touched `src/`, which is direct, independently-verified evidence that the certified champion was not modified and that no post-hoc optimization occurred.

**Audit decision: `PHASE_4A_AUDIT_PASS_WITH_LIMITATIONS`.** The evidence that exists (engineering) is trustworthy; the evidence that would validate alpha does not yet exist.

## §48 Audit-evidence table

| Claim | Evidence | Verified? | Limitation |
| --- | --- | --- | --- |
| Real market data consumed | No provider credentials; zero evidence corpora on disk | NO (none consumed) | Real-market data never fetched |
| PIT correctness | 3D/3M/3Q guards + 3T tests (future ts → DATA_INVALID) | YES (machinery) | Not exercised on real sessions |
| Model freeze | Last `src/` commit = `abbc403` (PHASE_3S); 3T/4A changed no src | YES | — |
| Execution realism (no perfect fills) | 3T test: fill_price ≠ signal_price; SAME_CLOSE rejected | YES (machinery) | Not exercised on real fills |
| Costs (India, PIT) | 3T test: F&O STT 0.0001 pre-2023 vs 0.000125 2023; stamp duty buy-only | YES (machinery) | Not applied to real trades |
| Reconciliation | `paper_ops/reconcile.py` + 3R tests (typed discrepancies) | YES (machinery) | No real sessions reconciled |
| Replay | `paper_ops`/`research.artifact` reproduce + 3R/3S tests | YES (machinery) | No real sessions replayed |
| P&L identity (net = gross − costs − slippage) | 3T property test | YES (machinery) | No real P&L computed |
| Calibration | 3F/3T machinery; `CalibratedProbability.unavailable` guard | YES (machinery) | No real predicted-vs-realized data |
| EV correctness | 3T independent recalc to 1e-6 | YES (machinery) | No real trades |
| IC / Rank IC | 3T matches scipy.stats.spearmanr | YES (machinery) | No real observations |
| Deciles / monotonicity | 3E/3S machinery | YES (machinery) | No real observations |
| Regimes / sectors / liquidity / F&O | 3H/3I/3S machinery | YES (machinery) | No real observations |
| Provider reliability (chain + fallback) | 3Q machinery; chain configured | YES (machinery) | No real provider calls |
| Security (no secrets) | grep `ml-service/src` = 0; no frontend public secrets | YES | — |
| Live-order isolation | grep `ml-service/src` order primitives = 0 (exit 1); LIVE_TRADING not active | YES | — |

"YES (machinery)" means the capability is implemented and test-covered but has not been exercised against real market data.

## Findings by severity (§49)

### CRITICAL — none
No confirmed lookahead leakage, no future-metadata leakage, no accidental live-order path, no exposed secret, no fabricated/contaminated evidence, no unsafe auto-promotion. Evidence integrity is not compromised (there is simply no alpha evidence to compromise).

### HIGH
- **H1 — Real-market evidence window not executed.** No live provider credentials and no real trading days elapsed → zero real sessions/trades. This materially limits (in fact prevents) any alpha interpretation. It is honestly disclosed and is the reason the alpha classification is `INSUFFICIENT_EVIDENCE`.

### MEDIUM
- **M1 — Deep-learning / RL runtime unexercised** (torch absent); portfolio-optimizer and several tests dependency-skipped (sklearn/talib). Certain paths remain UNVERIFIED at runtime in this environment.
- **M2 — Live-capable broker adapter exists in the repo** (TypeScript, `src/services/india/broker/openalgo-adapter.ts`), gated by `LIVE_TRADING_ENABLED` and outside the ML-service boundary. Not reachable from the Phase 4A workflow, but its existence warrants continued configuration discipline.

### LOW / INFORMATIONAL
- **L1 — Two pre-existing numpy divide warnings** in test_phase3d (cosmetic).
- **I1 — Statistical operating points are provisional** (calibrated on synthetic data); they should be recalibrated once real observations exist. Informational, by design.

## Engineering vs alpha (§46)

```
ENGINEERING_STATUS: PRODUCTION_READY_WITH_LIMITATIONS
    frozen system; regression 1570 passed / 28 skipped; live-order path absent;
    no secrets; reconciliation/replay/evidence-hash machinery test-covered.

ALPHA_STATUS: INSUFFICIENT_EVIDENCE
    zero real sessions/trades/observations; no real-market alpha has been tested.
```

## Paper-system status (§53)

`PAPER_SYSTEM_STATUS: OPERATIONAL_WITH_LIMITATIONS` — the paper machinery is engineered, tested, and safe, but has not run a real session; real-provider operation and real-session reconciliation/replay remain unexercised.

## Final recommendation (§55; recommendation only — no action taken)

1. Keep the champion frozen; make no code/model/threshold change based on this audit.
2. To collect real evidence: provision read-only provider credentials (backend/data-service only, never frontend), run frozen `PAPER_BASELINE_V1` in PAPER mode across a pre-specified real evidence window, accumulate immutable daily evidence packages with periodic replay/reconciliation, then re-run this audit on real observations.
3. Do not enable live trading. Route any future change through Phase 3S → OOS validation → lifecycle gates → human approval.

---

**PHASE_4A_AUDIT_PASS_WITH_LIMITATIONS**
**ALPHA_INSUFFICIENT_EVIDENCE**
**PAPER_SYSTEM_STATUS: OPERATIONAL_WITH_LIMITATIONS**
**LIVE_TRADING_STATUS: DISABLED**
