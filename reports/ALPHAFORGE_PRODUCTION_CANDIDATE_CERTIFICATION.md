# ALPHAFORGE PRODUCTION-CANDIDATE CERTIFICATION

**Date:** 2026-09-09.

> ## Certified state: **PAPER** · PRODUCTION_CANDIDATE: **NOT CERTIFIED**

The promotion-gate machine (`promotion-gates.ts`) requires all 18 mandatory gates to
pass for PRODUCTION_CANDIDATE. Current status:

| Gate | Status |
|---|---|
| No P0 leakage | ✅ (conservative resolver; purged CV) |
| No P0 data corruption | ✅ (provenance + reconciliation; no NSE) |
| Durable prediction persistence | ⚠️ built + wired to shadow; **live builder hook pending** |
| Durable outcome persistence | ⚠️ built + wired to shadow; live resolver hook pending |
| Reproducible inference | ⚠️ engines deterministic; e2e needs data |
| OOS calibration | ❌ INSUFFICIENT EVIDENCE |
| Quality monotonicity | ❌ NOT MEASURABLE |
| Grade monotonicity | ❌ NOT MEASURABLE |
| Positive net expectancy | ❌ negative on real data |
| Positive profit factor | ❌ 0.90 |
| Cost robustness | ⚠️ enforced in code; unproven on real fills |
| No severe model drift | ⚠️ monitor present; no series |
| Valid model provenance | ❌ deployed artifacts unversioned |
| Runtime integration verified | ⚠️ engines have callers; builder hook pending |
| End-to-end tests pass | ⚠️ unit/e2e-shadow pass; live e2e pending |
| Provider failover verified | ✅ |
| Abstention verified | ✅ (canonical authority + tests) |
| Risk controls verified | ❌ PortfolioRiskEngine unwired |

**Gates fully passing: ~4/18.** PRODUCTION_CANDIDATE requires all 18.

## Certification statement

AlphaForge is certified for **PAPER** only. It is **not** a PRODUCTION_CANDIDATE and is
**not** production-eligible. Profitability is **INSUFFICIENT EVIDENCE**; the one real
measurement is negative; the ML models have no OOS edge (0/7, DISABLED). No
profitability is claimed. Promotion beyond PAPER requires the failing gates to pass on
**real, persisted, out-of-sample** evidence that does not yet exist.
