# ALPHAFORGE — V5 DATA GATE REPORT (§60/§61)

## What was wired
V4 found `evaluateGlobalDataState`/`strategyMayOperate`/`evaluateSnapshotConsistency`
had ZERO production call sites. V5 wires the fail-closed enforcement into a real
production producer:

- **`worker/src/jobs/india-scalper.ts`** now calls `enforceDataGate(...)` per
  signal, using REAL persisted 5m coverage (`checkHistorySufficiency`) as the
  critical dependency. If the strategy's critical intraday data is genuinely
  UNAVAILABLE (0 persisted bars), the trade is blocked — NO SIGNAL — before the
  existing V2.1 HTTP gate. This is a data-integrity veto ON TOP of the existing
  logic; it reads NO strategy/ML/threshold and changes NO scoring (§61 / scope).

This is in addition to the pre-existing HTTP `evaluateDataGate` (data-service
`/data/gate`, fail-closed) already wired into india-scalper + auto-trader.

## Producers audited (from the V4 context map)
| Producer | Data gate now? |
|---|---|
| india-scalper (worker) | YES — V5 availability gate + V2.1 HTTP gate |
| auto-trader | V2.1 HTTP gate (pre-existing) |
| IndiaDailyPick builder | NO (session-guarded only) — candidate for wiring |
| FnoTrendScan | NO — candidate |
| StrategyPaperTrade / crypto scalper | NO — candidate |
| SignalHistory ingest | NO — candidate |

## Why not all producers were force-wired
Wiring a fail-closed gate into every producer can HALT live trading and is an
operational decision. V5 delivers the reusable `enforceDataGate` helper (the
migration surface, V4) + one real wired producer as the proven pattern, and lists
the remaining producers for operator-approved rollout. No gate was weakened.

## Status
- Gate enforcement helper: IMPLEMENTED + TEST-VERIFIED (blocks on
  UNAVAILABLE/PROVIDER_FAILED/snapshot-skew).
- Wired into india-scalper: IMPLEMENTED (tsc app+worker PASS).
- Full-producer coverage: PARTIAL — remaining producers flagged for rollout.
