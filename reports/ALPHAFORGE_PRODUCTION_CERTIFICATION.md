# ALPHAFORGE PRODUCTION CERTIFICATION

**Date:** 2026-09-09 · Commit `1c2941b` (+ additive remediation).

> ## Certified system state: **PAPER**  ·  Production: **NOT CERTIFIED**

The promotion-gate machine (`src/lib/india/promotion-gates.ts`) evaluates the 18
mandatory gates. On current evidence the result is **PAPER** (with the two
catastrophic gates passing) — production is refused. Automatic promotion to
PRODUCTION is impossible by design; the best a machine evaluation yields is
PRODUCTION_CANDIDATE, and only when all 18 gates pass.

## Mandatory production gates (current status)

| Gate | Status | Basis |
|---|---|---|
| No P0 leakage | ✅ PASS | conservative both-touched→stop resolver; PIT/purged CV in training |
| No P0 data corruption | ✅ PASS | provider provenance + exact P&L reconciliation; no direct NSE |
| Durable prediction persistence | ⚠️ AVAILABLE, NOT WIRED | `PrismaSignalRecordStore` added; not yet called by live path |
| Durable outcome persistence | ⚠️ AVAILABLE, NOT WIRED | `IndiaResolutionRecord` added; not yet written by resolver |
| Reproducible inference | ⚠️ PARTIAL | engines pure/deterministic; full e2e needs creds + data |
| OOS calibration | ❌ FAIL | runtime meta untrained; calibration NOT MEASURABLE |
| Quality monotonicity | ❌ FAIL | NOT MEASURABLE (no quality persisted per trade) |
| Grade monotonicity | ❌ FAIL | NOT MEASURABLE (no grade persisted per trade) |
| Positive net expectancy | ❌ FAIL | −0.18%/trade on the only real dataset |
| Positive profit factor | ❌ FAIL | PF 0.90 (below 1.0) |
| Cost robustness | ❌ FAIL/moot | edge negative before full cost stack |
| No severe model drift | ⚠️ N/A | drift monitor exists; no durable series yet |
| Valid model provenance | ❌ FAIL | deployed artifacts carry no provenance |
| Runtime integration verified | ❌ FAIL | new engines have 0 runtime callers |
| End-to-end tests pass | ❌ FAIL | only unit tests exist for the new stack |
| Data-provider failover verified | ✅ PASS | registry + failover unit-tested |
| Abstention verified | ⚠️ PARTIAL | abstention logic tested; not wired end-to-end |
| Risk controls verified | ❌ FAIL | `PortfolioRiskEngine` unwired (RISK-001) |

**Gates passing: 3 fully + several partial. Production requires all 18.**

## Certification statement

AlphaForge is **NOT certified for production or live trading**. It is certified only
for **PAPER** operation, where signals may be generated and outcomes collected but no
capital is at risk. Promotion beyond PAPER requires the failing gates above to pass on
**real, persisted, out-of-sample** evidence — which does not exist today. This
certification does not claim profitability; the profitability evidence is
**INSUFFICIENT** and the one real measurement is negative.
