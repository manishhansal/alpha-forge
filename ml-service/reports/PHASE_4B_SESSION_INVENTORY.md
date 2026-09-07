# Phase 4B — Session Inventory

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service` · **HEAD:** `af62b13`
**Date:** 2026-09-06 · **Mode:** PAPER-ONLY · **Live trading:** DISABLED

---

## Sessions

| session_id | trading_date | provider | fallback_used | model_hash | config_hash | data_hash | decisions | trades | reconciliation | replay | evidence_status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _(none)_ | — | — | — | — | — | — | — | — | — | — | — |

**Zero real-market paper sessions.** The evidence window has not begun; the first session is gated behind human credential setup (see `PHASE_4B_ENTRY_GATE.md`).

## Cumulative evidence counters (§26)

| Counter | Value |
| --- | --- |
| REAL_SESSIONS | 0 |
| REAL_TRADES | 0 |
| INDEPENDENT_SIGNAL_EVENTS | 0 |
| INSTRUMENTS | 0 |
| REGIMES | 0 |

## Evidence window (§27)

| Field | Value |
| --- | --- |
| evidence_start | NOT_STARTED |
| planned_evidence_end | NOT_PRE-SPECIFIED |
| minimum_session_target | NOT_PRE-SPECIFIED |
| minimum_trade_target | NOT_PRE-SPECIFIED |
| minimum_regime_coverage | NOT_PRE-SPECIFIED |

The original Phase 4A specification did not define numerical statistical thresholds. Per §27, these are recorded as `NOT_PRE-SPECIFIED` rather than invented retroactively. The evidence window (start, end, and minimum targets) must be defined by a human **before** the first session and recorded here immutably.

## Status

Inventory awaiting credentials. No session may be added until the entry gate passes.
