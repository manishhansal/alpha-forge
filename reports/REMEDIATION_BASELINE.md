# REMEDIATION BASELINE (Phase 0)

**Captured before any remediation change.** This file is a frozen snapshot; it is
not overwritten by later phases.

## Git checkpoint
- Commit: `1c2941b754a55bf0e28e90459b49f755f211c3ea`
- Branch: `refactor/signals`
- Date: 2026-09-09

## Test suite (baseline)
| Metric | Value |
|---|---|
| Test files | 208 |
| Tests passed | 3280 |
| Tests failed | 0 |
| Tests skipped | 0 |
| Duration | ~9.8s |

## Database
- Reachable at `localhost:5433` (PostgreSQL `crypto_dashboard`).
- 15 migrations present; **1 pending migration NOT authored by this remediation**
  (`20260905000000_restore_candle_bar_composite_index`) — left untouched. No
  destructive DB operations (`migrate reset`) will be run.

## Preserved audit metrics (from the independent audit at `1c2941b`)
These are the reference numbers this remediation must not paper over.

| Metric | Value |
|---|---|
| Real ledger trades | 321 (single session) |
| Resolved win rate | 25.68% |
| Avg return / trade | −0.18% |
| Total realized P&L | −₹32,624 |
| Break-even win rate | 42.01% |
| Realized net expectancy | NEGATIVE |
| ML models gate-passing | 0 / 7 |
| Regime classifier OOS accuracy | ≈ 0.474 |
| Stock-ranker OOS IC | ≈ 0.0041 |
| Risk model | validation gate failed (single-class fold) |
| Strategy model | dependency-blocked (catboost/numpy) |
| New engines wired to runtime | NONE (`runAPlusFactory` / `runProfitabilityPipeline` / meta resolver have no callers) |
| Durable outcome persistence | NONE (in-memory `SignalRecordStore` only) |
| Grade/quality/probability/regime persisted per resolved trade | 0 / 321 |

## Baseline verdict
AlphaForge **must not** be treated as a profitable production system at baseline.
Correct production posture: **PAPER / ABSTAIN**. This remediation adds the P0
foundations (durable persistence, model-state gating, promotion gates, regression
guards) without destabilising the one working live path, and documents the remainder
as tracked P0/P1 work. It does **not** manufacture profitability.
