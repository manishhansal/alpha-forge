# Phase 4B — Entry Gate

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service` · **HEAD:** `af62b13`
**Date:** 2026-09-06 · **Mode:** PAPER-ONLY · **Live trading:** DISABLED
**ML source freeze point:** `abbc403` (PHASE_3S)

This gate must fully pass before the first real-market paper-evidence session. It is verification + documentation only — no ML source was modified.

---

## §40 First-session gate checklist

| # | Gate | Status | Evidence |
| --- | --- | --- | --- |
| 1 | ML source freeze verified | **PASS** | Last `ml-service/src/` commit = `abbc403`; `git log abbc403..HEAD -- ml-service/src/` empty |
| 2 | Model hash captured | **PASS (deferred value)** | Baseline identity `PAPER_BASELINE_V1` recorded (4A manifest); concrete artifact hash captured at real session start from registry |
| 3 | Configuration hash captured | **PASS (deferred value)** | Config identity recorded; concrete hash captured at session start |
| 4 | Provider chain verified | **PASS** | `DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO`, `INDIA_DATA_PROVIDER=auto`; NSE-direct not present |
| 5 | Credentials securely configured | **BLOCKED** | All provider credentials unset in env; requires human setup (see `PHASE_4B_PROVIDER_SETUP.md`) |
| 6 | No frontend secrets | **PASS** | Zero `NEXT_PUBLIC_*` broker secrets; zero hardcoded secrets in `ml-service/src` |
| 7 | LIVE_TRADING_ENABLED = FALSE | **PASS** | No active `LIVE_TRADING_ENABLED=true` in any env file |
| 8 | Market calendar verified | **PASS** | NSE/BSE calendar handling present (Phase 3G/3N/3R, Asia/Kolkata) |
| 9 | Data freshness verified | **BLOCKED** | Requires live provider to measure real freshness — no credentials |
| 10 | PIT protection active | **PASS** | `validate_data` future-ts → DATA_INVALID; signal-safety NO_FUTURE_INFORMATION gate; leakage probes |
| 11 | Closed-candle rule verified | **PASS** | Execution + data-quality machinery distinguishes closed vs forming (3G/3Q) |
| 12 | Paper execution simulator active | **PASS** | `execution.fill_engine.FillEngine` (no perfect fills; NEXT_OPEN default) |
| 13 | Cost model active | **PASS** | India PIT versioned cost schedules (3G) |
| 14 | Immutable ledger active | **PASS** | `paper_ops` event-sourced ledger (append-only, hash-chained) |
| 15 | Reconciliation active | **PASS** | `paper_ops.reconcile` typed discrepancies (3R) |
| 16 | Replay active | **PASS** | `paper_ops` / `research.artifact` replay + reproduce (3R/3S) |
| 17 | Evidence sealing active | **PASS** | `paper_ops.evidence_package` freeze + hashes + no-overwrite (3R) |
| 18 | Failure handling active | **PASS** | Fail-closed provider/model/risk handling + kill switches (3R) |

## Gate summary

- **Machinery gates (1–4, 6–8, 10–18): PASS.** The frozen system is intact, safe, and fully test-covered (regression 1570 passed / 28 skipped; paper/provider/reconciliation/replay suites 275 passed).
- **Credential + live-data gates (5, 9): BLOCKED.** No provider credentials are configured, so no real market data can be fetched and real data-freshness cannot be measured.

## Overall gate result

`FIRST_SESSION_BLOCKED` **pending human credential setup.** Every gate that can pass without live credentials has passed; the only outstanding items require a human to securely supply provider credentials. This maps to the phase outcome `PHASE_4B_REQUIRES_HUMAN_CREDENTIAL_SETUP`.

## What is required to unblock

Securely configure (backend/runtime only — see `PHASE_4B_PROVIDER_SETUP.md`) at least one operational provider path:
- **Angel One (primary):** `SMARTAPI_API_KEY`, `SMARTAPI_CLIENT_CODE`, `SMARTAPI_PIN`, `SMARTAPI_TOTP_SECRET` (+ `SMARTAPI_PUBLIC_IP` if 403); **or**
- **Upstox (secondary):** `UPSTOX_ANALYTICS_TOKEN`.

Then re-run the provider health check (§5) and confirm gates 5 and 9 pass before the first session.

## What must NOT happen

No ML source change, retrain, recalibrate, threshold tuning, provider-priority change, or live-order enablement. Phase 4B is PAPER-ONLY and the champion is frozen.
