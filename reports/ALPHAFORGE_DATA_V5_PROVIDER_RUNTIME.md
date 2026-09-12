# ALPHAFORGE — V5 PROVIDER RUNTIME (§7/§82)

Real runtime evidence from actual authenticated provider calls (2026-09-11).
`provider_observation` = **51 real rows** (demo purged in V4; all V5 obs are real).

## Provider table (§82) — actual evidence

| Provider | Configured | Authenticated | Quote | 1m | 3m | 5m | 15m | 30m | 1h | Options | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|---|
| data-service | yes (URL) | yes (quote) | VERIFIED | — | — | current-day | current-day | current-day | current-day | — | quote-only |
| Angel One | yes (DB) | **VERIFIED** (SmartAPI login) | VERIFIED | VERIFIED | UNSUPPORTED | **VERIFIED** | **VERIFIED** | **VERIFIED** | **VERIFIED** | VERIFIED (OI; IV/bid/ask NULL) | LIVE-RUNTIME-VERIFIED |
| Upstox | yes (DB) | **VERIFIED** (V3 200) | VERIFIED | **VERIFIED** | **VERIFIED** | **VERIFIED** | **VERIFIED** | **VERIFIED** | **VERIFIED** | NOT_VERIFIED (v2 chain 400 w/o expiry) | LIVE-RUNTIME-VERIFIED |
| Yahoo | yes (none) | NOT_VERIFIED | — | — | — | supported | supported | supported | supported | UNSUPPORTED (no OI/IV) | not exercised |

Legend: VERIFIED = a real successful request was made this phase; UNSUPPORTED =
provider genuinely can't serve it; NOT_VERIFIED = not exercised.

## Real evidence highlights
- **Angel One**: real SmartAPI login (apiKey+clientCode+pin+TOTP → JWT + feed token). Historical `getCandleData` real for equities (RELIANCE 5m = 366 in 5d; SBIN/INFY/TCS/HDFCBANK/ICICIBANK likewise). **Index tokens (NIFTY/BANKNIFTY) return EMPTY via getCandleData** — a genuine Angel behaviour, not a bug in our call (token resolves correctly to 26000/26009). Option chain: real strike-level OI (91 NIFTY / 145 BANKNIFTY strikes) — IV & bid/ask NULL (Angel chain synthesis doesn't supply them).
- **Upstox**: analytics-token auth works (HTTP 200). **V2** historical only supports `1minute/30minute/day` — NOT 5m/15m/1h. **V3** `/v3/historical-candle/{key}/{unit}/{value}/{to}/{from}` supports minutes/1,3,5,15,30 + hours/days AND serves **indices** (NIFTY 5m=225 verified). V5 added `getHistoricalCandlesV3` + fixed a newest-first ordering bug that had dropped all-but-one candle.
- **data-service**: live NIFTY quote 200 (volume null preserved). No multi-day intraday history (unchanged).

## Reliability (sample-size honest, §19/§43)
`provider_observation` = 51 real. Once MIN_SAMPLE (20) real observations exist
per provider, `computeProviderReliability` reports a real success rate;
below that it reports INSUFFICIENT_SAMPLE (never a false 100%). Angel + Upstox
now exceed the threshold in aggregate from the backfill runs.

## Token semantics (§12)
Upstox **Analytics Token** (stored) powers market-data + historical + streaming —
correct for all data paths. Access Token is the OAuth trading token (not used
for data). Angel uses the SmartAPI login JWT (per-session, midnight-IST expiry,
re-login on demand).
