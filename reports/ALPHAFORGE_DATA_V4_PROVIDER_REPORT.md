# ALPHAFORGE — DATA FOUNDATION V4 PROVIDER REPORT

From the durable `provider_observation` table (demo contamination purged) +
config-health + runtime-aware matrix. Sample-size honesty enforced (§19):
no reliability % is asserted below `MIN_SAMPLE=20`.

## 1. Contamination purge (§10/§61)
Before: `provider_observation = 12`, of which **11 were `__V3DEMO__` demo
fixtures** attributed to `angel_one` (V3 backfill demo). These would have
falsely credited Angel One. **Purged (DB-VERIFIED): 11 deleted, 1 real remains.**
CandleBar + OptionChainSnapshot: no demo contamination found.

## 2. Provider reliability (real observations only)

| provider | sample | success | failure | successRate | p50 | p95 | status |
|---|---|---|---|---|---|---|---|
| scrapling | 1 | 1 | 0 | **null** | 95 ms | 95 ms | INSUFFICIENT_SAMPLE |
| angel_one | 0 | — | — | null | — | — | NOT_VERIFIED (no creds) |
| upstox | 0 | — | — | null | — | — | NOT_VERIFIED (no creds) |
| yahoo | 0 | — | — | null | — | — | NOT_VERIFIED |

The single scrapling observation (live NIFTY quote, HTTP 200, 95 ms, `volume`
preserved null) is real but **too small to certify reliability** — reported as
INSUFFICIENT_SAMPLE, NOT 100%.

## 3. Config health (§12 — no secrets)

| provider | configured | credentialsComplete | authenticated | missing fields | source |
|---|---|---|---|---|---|
| scrapling | yes | yes | **yes** (1 real obs) | — | env (DATA_SERVICE_URL) |
| angel_one | no | no | no | SMARTAPI_API_KEY, CLIENT_CODE, PIN, TOTP_SECRET | per_user_db_possible |
| upstox | no | no | no | UPSTOX_ANALYTICS_TOKEN\|ACCESS_TOKEN\|(CLIENT_ID+SECRET) | per_user_db_possible |
| yahoo | yes | yes | no | — (no creds required) | none |

`authenticated` is evidence-based (a real successful observation), NOT mere
credential presence.

## 4. Runtime-aware capability matrix (§16)
Static capability (matrix) vs runtime (real observations): **every
provider×interval is `NOT_VERIFIED`** — the only real observation is a quote, and
the demo candle observations were purged, so no candle capability is
runtime-verified. Static support is unchanged from V3 (Angel/Upstox: full
intraday history; scrapling: daily + current-day intraday; Yahoo: fallback).

## 5. Failure classification / failover (§17/§18/§32/§33)
Classification (401/403→AUTH_FAILED, 429→RATE_LIMITED, 5xx/timeout→PROVIDER_FAILED,
403-rate→rate_limit not blind-retry) is IMPLEMENTED + unit-tested (V2/V3). A real
broker failover drill is **NOT_VERIFIED** (no credentials, market closed).

## 6. Verdict
- scrapling: LIVE quote path LIVE-RUNTIME-VERIFIED (1 obs); reliability INSUFFICIENT_SAMPLE.
- angel_one / upstox: **NOT_VERIFIED** (no credentials).
- yahoo: **NOT_VERIFIED** (not exercised this pass).
