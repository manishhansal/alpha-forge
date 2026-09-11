# ALPHAFORGE — DATA FOUNDATION V4 BASELINE

Exact starting state, re-queried live (V3 numbers were NOT assumed current).

- **queriedAt:** 2026-09-11 ~10:25Z (**15:55 IST, Friday — NSE session CLOSED**, regular close 15:30).
- **database:** `postgresql://crypto:****@localhost:5433/crypto_dashboard` (docker `alpha-forge-postgres`, healthy).
- **environment:** local docker — Postgres 5433, Redis 6379, data-service 8200, ml-service 8100 all healthy.
- **git HEAD:** `7a977fd` (V3 commit) on `refactor/signals`.
- **probe scripts:** `scripts/data-v3-db-probe.ts`, `scripts/data-v4-daily-integrity-analysis.ts`, `scripts/data-v4-daily-conflict-detail.ts` (all read-only).

## Provider configuration (real)
- Chain: scrapling (data-service) → angel_one → upstox → yahoo.
- `SMARTAPI_*` = **empty**, `UPSTOX_*` = **empty** → Angel One + Upstox **unusable**.
- `DATA_SERVICE_URL` set → scrapling enabled. Market is CLOSED, so even a live
  data-service quote probe reflects a closed session.
- **Consequence:** every credential-dependent V4 objective (Angel/Upstox live
  validation, real broker failover drill, real multi-day intraday backfill, F&O
  strike capture via broker) is **LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE**.
  Nothing is fabricated to compensate.

## Current DB state (real, 2026-09-11)
| Item | Value |
|---|---|
| CandleBar total | **89,810** |
| — by interval | `1d` = 89,810; 1m/3m/5m/10m/15m/30m/1h = **0** |
| — by exchange | NSE = 89,810 |
| distinct instruments | 175 |
| candlesWithProvider | **0 / 89,810** |
| datasetVersion / receivedAt populated | 0 / 0 |
| OptionChainSnapshot | ~2,941 (FINNIFTY 738, NIFTY 736, BANKNIFTY 736, MIDCPNIFTY 731); last 2026-09-10 |
| stock-option snapshots | 0 |
| data_gap | 0 |
| data_quality_incident | **2** (V3 D-V2-10 findings) |
| provider_observation | **12** |
| data_correction | 0 |
| demo/`__V3DEMO__` rows | 0 (cleaned) |

Unchanged from the V3 end-state — no drift, no new intraday, no new provenance.

## Daily-integrity findings (real, this pass — see DAILY_NORMALIZATION_PLAN_V4)
- Timestamp conventions: 09:15 IST **85,058** · 18:30 IST **4,414** · 00:00 IST **175** · 09:00 IST **163**.
- Logical trading days: **86,227**. Weekend daily bars: **1,029**. Logical duplicate trading-days: **3,442**.
- **All 3,442 duplicates are VALUE_CONFLICT** (materially different OHLC+volume) — NOT exact duplicates; neither side carries provenance.

## V4 objectives scoped to what is verifiable here
1. Daily-integrity: evidence-based normalization plan + safe two-stage migration + a canonical `sessionDate` uniqueness model (design/additive, not auto-applied).
2. Demo/test contamination audit + source classification.
3. Config-health service (per-provider, no secrets) + runtime-aware capability matrix.
4. Provider-observation sample-size honesty + instrumentation-coverage audit.
5. Data-gate enforcement trace + fail-closed proof on the real path.
6. Consumer migration audit (`*WithStatus`).
7. Full-universe gap detection (real daily).
8. F&O coverage measurement + strike-level model design.
9. Migration-drift inspection.
10. Honest V4 reports with evidence tiers; retain D-V4-01…21.

Explicitly NOT achievable here (no creds / market closed): real Angel/Upstox
runtime, real broker failover drill, real intraday backfill, broker F&O capture.
These are reported NOT_VERIFIED / DATA_INSUFFICIENT — never fabricated.
