ALPHAFORGE V5 DATA ACQUISITION CERTIFICATION

Companion reports: V5_BASELINE, V5_CREDENTIAL_FLOW, V5_PROVIDER_RUNTIME,
V5_INTRADAY_COVERAGE, V5_OPTION_COVERAGE, V5_INSTRUMENT_MASTER, V5_GAP_REPORT,
V5_DATA_GATE_REPORT, V5_ROOT_CAUSE_REPORT.

**The headline: intraday is no longer 0. Real Angel One + Upstox market data now
flows to Postgres.** The root cause — the worker could not read
frontend-configured broker credentials from the DB (session-only resolvers) — is
fixed. No data was fabricated; no ML/signal/threshold code was changed.

---

## §89 certification (each with real evidence)

| Item | Verdict | Evidence |
|---|---|---|
| REAL PROVIDER AUTHENTICATION | **PASS** | Angel SmartAPI TOTP→JWT login succeeded; Upstox analytics-token V3 HTTP 200 |
| REAL INTRADAY ACQUISITION | **PASS** | 5m/15m/30m/1h persisted for 8 instruments (see below) |
| REAL HISTORICAL ACQUISITION | **PASS (shallow)** | ~5 sessions each; deeper via `data:backfill --range` |
| REAL OPTION ACQUISITION | **PARTIAL** | 944 strike rows w/ real OI (NIFTY/BANKNIFTY); IV/bid/ask unavailable via current path |
| REAL PERSISTENCE | **PASS** | provider count == DB count verified; provenance stamped |
| REAL COVERAGE | **PASS** | DB-derived counts below |
| REAL GAP RECOVERY | **PARTIAL** | mechanism run against real provider; daily gaps UNRESOLVED pending normalization (fail-closed, correct) |
| REAL FAILOVER | **PARTIAL** | capability-aware routing + empty-failover exercised (indices Angel→Upstox); full injected-failure drill not run |
| REAL DATA-GATE ENFORCEMENT | **PARTIAL** | wired fail-closed into india-scalper; other producers pending |

## Real DB counts (§81, queried 2026-09-11)
```
CandleBar 5m   2,796   (angel_one + upstox)
CandleBar 15m    950
CandleBar 30m    494
CandleBar 1h     266
CandleBar 1m/3m    0   (provider-supported; not backfilled)
CandleBar 1d  89,810   (legacy, provider NULL)
by provider:  angel_one 3,546 | upstox 960 | NULL 89,810
distinct intraday instruments: 8 (RELIANCE,HDFCBANK,ICICIBANK,INFY,TCS,SBIN,NIFTY,BANKNIFTY)
OptionChainStrike  944  (NIFTY 364, BANKNIFTY 580; OI real, IV/bid/ask NULL)
OptionChainSnapshot 2,941 (aggregate, legacy)
DataGap 245 | DataCorrection 0 | DataQualityIncident 2 | ProviderObservation 51 (real)
```

## §85 signal-readiness contract (values from real evidence)
```json
{
  "dataReadyForSignalAnalysis": false,
  "requiredCapabilities": {
    "equity_intraday": true,
    "index_intraday": true,
    "historical_intraday": "shallow",
    "option_chain": "partial",
    "oi": true,
    "iv": false,
    "volume": true,
    "live_data": false
  },
  "providers": { "angel_one": "VERIFIED", "upstox": "VERIFIED" },
  "coverage": { "5m": 2796, "15m": 950, "30m": 494, "1h": 266, "1m": 0, "3m": 0 },
  "gaps": { "daily": 245, "resolved": 0 },
  "warnings": [
    "intraday history shallow (~5 sessions) — extend backfill for feature warm-up",
    "1m/3m not backfilled (provider-supported)",
    "option IV/bid/ask unavailable via current chain path",
    "daily normalization (D-V4-01) unapplied → daily gap recovery blocked",
    "realtime WS feed not activated (historical path prioritised)",
    "full F&O universe not backfilled (8 instruments)"
  ]
}
```
`dataReadyForSignalAnalysis` is **false** by honest evidence: the pipeline is
real and working, but depth/coverage/live/options are not yet at full-strategy
level. It is NOT set true to satisfy the criterion (§85/§57).

## §86 success-condition check
- intraday = 0 while claiming complete? **NO** — intraday is real and non-zero.
- credentials in frontend but runtime can't see them? **FIXED**.
- provider client exists but no real request? **NO** — real requests executed.
- API returned data but Postgres 0 rows? **NO** — provider count == DB count.
- data gate bypasses rows? Gate wired into india-scalper (partial coverage).

## Verification (exact)
tsc app+worker PASS · prisma validate PASS + migrate status clean · eslint 0
errors · vitest **3,419 pass / 219 files** (+12 V5) · pytest 664 pass/25 skip ·
`npm run build` PASS · `data:self-test` PASS · `data:readiness` OK.

## What remains (honest, for the operator)
1. Backfill 1m/3m + the full F&O universe + deeper history (`data:backfill` run-params).
2. Apply the V4 daily normalization, then re-run daily gap recovery.
3. Option greeks (IV/bid/ask) via Angel `optionGreek` / Upstox chain with expiry.
4. Activate a realtime WS feed (Angel/Upstox) for live intraday.
5. Roll the data gate out to the remaining producers (operator-approved).

## Bottom line
The real provider → database path **works**. Angel One and Upstox are
authenticated and persisting real NSE intraday + index + option-OI data with
full provenance. The remaining items are depth/coverage/rollout — not the
fundamental break, which is fixed.
