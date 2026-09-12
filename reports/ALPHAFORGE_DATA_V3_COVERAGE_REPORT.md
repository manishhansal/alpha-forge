# ALPHAFORGE — DATA FOUNDATION V3 COVERAGE REPORT (REAL, DB-DERIVED)

All numbers queried live from `crypto_dashboard` @ localhost:5433 via the Prisma
adapter (`scripts/data-v3-db-probe.ts` + `scripts/data-v3-runtime-pipeline.ts`).
**queriedAt: 2026-09-10T07:39:39Z** · environment: local docker Postgres.
Nothing fabricated (Absolute Rule 20).

---

## 1. Candle coverage (`candle_bar`)

| interval | instruments | actual bars | expected (NSE-calendar) | completeness | readiness |
|---|---|---|---|---|---|
| **1d / NSE** | 175 | **89,810** | ~89,810 over span | **~1.00** | **DATA_READY** |
| 1m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 3m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 5m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 10m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 15m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 30m | 0 | 0 | — | 0 | DATA_INSUFFICIENT |
| 1h | 0 | 0 | — | 0 | DATA_INSUFFICIENT |

Daily span: 2024-09-04 → 2026-09-09. Completeness is computed by the calendar-aware
coverage engine (`buildCoverageMatrix` + `nseCalendar`).

**Daily data-quality caveat (D-V3-04):** of the 89,810 daily rows, 84,889 use the
canonical 09:15-IST convention; 4,921 use foreign conventions producing **3,442
logical duplicate trading-days** and **1,029 weekend bars**. The per-trading-day
coverage count is robust to this, but the raw row count is inflated by the
duplicates. A dry-run migration to normalise is provided (not applied).

## 2. Option-chain coverage (`OptionChainSnapshot`)

| underlying | snapshots | first | last | readiness |
|---|---|---|---|---|
| FINNIFTY | 738 | 2026-06-16 | 2026-09-10 | DATA_DEGRADED |
| NIFTY | 736 | 2026-06-16 | 2026-09-10 | DATA_DEGRADED |
| BANKNIFTY | 736 | 2026-06-16 | 2026-09-10 | DATA_DEGRADED |
| MIDCPNIFTY | 731 | 2026-06-16 | 2026-09-10 | DATA_DEGRADED |
| **Total** | **~2,941** | | | |

Aggregate analytics only (no per-strike OI/IV time series). Stock options: **0
snapshots → DATA_INSUFFICIENT**. See `ALPHAFORGE_DATA_OPTION_COVERAGE_REPORT.md`.

## 3. Durable reliability tables (now REAL — first time populated)

| table | V3 baseline | V3 end | source of rows |
|---|---|---|---|
| `provider_observation` | 0 | **12** | real live-quote + backfill/gap observations |
| `data_quality_incident` | 0 | **2** | D-V3-04 duplicate + weekend findings (deduped) |
| `data_gap` | 0 | **0** | gap detector ran; daily series had no missing bars (true negative) |
| `data_correction` | 0 | **0** | no conflicting re-fetch occurred |

`data_gap=0`/`data_correction=0` are HONEST negatives, not "not run" — the gap
detector executed against RELIANCE daily and correctly found nothing missing;
corrections require a differing re-fetch, which did not occur.

## 4. Provenance coverage

`candlesWithProvider = 0 / 89,810`. Existing daily rows keep NULL provenance by
design (never fabricated, Rule 17) → **PROVENANCE_UNKNOWN**. All NEW writes
(backfill/write-through/recovery) stamp `provider`+`datasetVersion`+
`sourceTimestamp` — DB-VERIFIED on the demo run (1,875 rows, 100% stamped) then
cleaned up.

## 5. Capability-specific readiness (machine-readable, DB-derived)

```
1d equities        DATA_READY
1m equities        DATA_INSUFFICIENT
3m equities        DATA_INSUFFICIENT
5m equities        DATA_INSUFFICIENT
10m equities       DATA_INSUFFICIENT
15m equities       DATA_INSUFFICIENT
30m equities       DATA_INSUFFICIENT
1h equities        DATA_INSUFFICIENT
index options      DATA_DEGRADED
stock options      DATA_INSUFFICIENT
OVERALL            DATA_INSUFFICIENT
```

A single global label is never used to hide a capability deficiency (§29/§51).
