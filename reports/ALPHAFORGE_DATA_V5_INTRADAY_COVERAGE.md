# ALPHAFORGE — V5 INTRADAY COVERAGE (REAL, DB-DERIVED)

Queried from `candle_bar` @ localhost:5433, 2026-09-11. **Intraday is no longer
zero** — this is the headline V5 result.

## Real intraday rows

| interval | rows | first | last | providers |
|---|---|---|---|---|
| 1m | 0 | — | — | (not backfilled this pass; Angel 1m + Upstox V3 1m both work) |
| 3m | 0 | — | — | (Upstox V3 supports; not backfilled) |
| **5m** | **2,796** | 2026-09-07T03:45Z | 2026-09-11T09:55Z | angel_one (equities) + upstox (indices) |
| **15m** | **950** | 2026-09-07 | 2026-09-11 | angel_one + upstox |
| **30m** | **494** | 2026-09-07 | 2026-09-11 | angel_one + upstox |
| **1h** | **266** | 2026-09-07 | 2026-09-11 | angel_one + upstox |
| 1d | 89,810 | 2024-09-04 | 2026-09-09 | legacy (provider NULL) |

By provider: **angel_one = 3,546**, **upstox = 960**, NULL (legacy daily) = 89,810.
Distinct intraday instruments: **8** (RELIANCE, HDFCBANK, ICICIBANK, INFY, TCS,
SBIN via Angel; NIFTY, BANKNIFTY via Upstox V3).

## What is DATA_READY vs not
- **5m/15m/30m/1h equity (6 names) + index (NIFTY/BANKNIFTY): real data present**, ~5 sessions depth. This is enough to prove the pipeline and to compute short-window intraday features; it is NOT yet the full F&O universe or long history.
- **1m/3m: 0 rows** — supported by the providers, just not backfilled this pass (a `data:backfill --intervals=1m,3m` run adds them).
- Historical depth ≈ 5 sessions (limited by the `range=5d` used). §64 minimum-warm-up backfill (e.g. EMA200 needs 200 bars) requires a longer backfill run — the mechanism is proven, the depth is a run-parameter.

## How it was acquired (real)
`npm run data:backfill -- --symbols=… --intervals=5m,15m,30m,1h --range=5d`
routes each symbol capability-aware: equities → Angel `getCandleData`; indices →
Upstox V3. Every candle carries provenance (`provider`, `datasetVersion`,
`sessionDate`). Idempotent via the CandleBar composite unique key.

## Honest status
```
5m equities   DATA_READY (shallow depth)
15m equities  DATA_READY (shallow)
30m equities  DATA_READY (shallow)
1h equities   DATA_READY (shallow)
5m/15m/30m/1h indices  DATA_READY (shallow, via Upstox V3)
1m / 3m       DATA_INSUFFICIENT (0 rows — not backfilled, provider-supported)
full F&O universe intraday  DATA_INSUFFICIENT (only 8 instruments)
long history  DATA_INSUFFICIENT (~5 sessions; extend via backfill --range)
```
