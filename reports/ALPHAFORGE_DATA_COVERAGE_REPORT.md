# ALPHAFORGE — DATA COVERAGE REPORT

Purpose (brief §73): report historical coverage — date range, instruments,
timeframes, candle counts, missing intervals, provider distribution,
completeness, stale/invalid data, and option/OI/IV coverage.

> **HONESTY NOTE (brief §88):** Real coverage *numbers* (candle counts, exact
> date ranges, missing-interval lists) are **NOT VERIFIED** in this pass. They
> require live queries against the Postgres `CandleBar` / `OptionChainSnapshot`
> tables and the providers, which were not executed. What follows is the
> **coverage capability map** — where each kind of history comes from, and the
> infrastructure that must exist to produce the numeric report reliably.

---

## 1. Where historical data comes from (capability)

| Timeframe | Source (implemented) | Persistence |
|---|---|---|
| Daily (1d) | data-service Bhavcopy (NSE/BSE), Angel, Upstox, Yahoo | `CandleBar` (upsert, idempotent) |
| Intraday 5m/15m/1h | Angel One (ranged, volume-bearing) | `CandleBar` |
| Intraday 1m | Upstox / Angel | `CandleBar` |
| Intraday (current day, index) | data-service NSE chart-databyindex (synthesized OHLC, **volume=0**) | `CandleBar` |
| Weekly / monthly | Yahoo | `CandleBar` |
| Option chain analytics | data-service NSE/BSE; captured on cadence | `OptionChainSnapshot` |

## 2. Persistence model coverage

- `CandleBar`: `open/high/low/close` (Float), `volume` (default 0), `oi`
  (nullable), `oiChange` (nullable), unique `(instrumentId, exchange,
  intervalStr, time)`, indexed on the same + `confirmedAt`.
- `OptionChainSnapshot`: aggregated analytics (`pcrOi`, `maxPain`, `atmIv`,
  `total*Oi`) + full `analytics` JSON blob; indexed on
  `(underlying, capturedAt)` and `capturedAt`.

## 3. Coverage completeness — capability gaps

| Requirement (brief) | Status |
|---|---|
| §7 coverage matrix instrument×date×timeframe×provider | **MISSING** — no such table; would be built from `CandleBar` + a provider column |
| §8 "enough valid data for this feature" as data | **PARTIAL** — feature-readiness logic exists on the signal side (`feature-quality-validator.ts`) but the historical service returns bare `[]` with no `INSUFFICIENT_HISTORY` |
| Provider distribution per candle | **MISSING** — `CandleBar` has no `provider` column, so provider distribution cannot be reported from the DB. (Provenance recommendation in readiness cert.) |
| Missing-interval accounting | **MISSING** — no `DataGap` ledger (see gap report §B) |
| Option / OI / IV coverage | **PARTIAL** — `OptionChainSnapshot` captures aggregate analytics; per-strike OI/IV history is not persisted; missing-OI now flagged (post-fix) but not yet stored as such |

## 4. Completeness vs. quality (brief §77)

The audit deliberately separates:
- **Completeness** — do we have all expected intervals? (needs the coverage
  matrix + gap ledger above — currently not measurable from the DB).
- **Validity** — are the candles we have structurally sound? (**YES** — enforced
  by `candle-validator.ts` / `_validate_candle_row`, reject-on-invalid).
- **Freshness** — `STALE_THRESHOLDS_MS` per data type.
- **Provenance** — partial; `CandleBar` lacks a provider column.

A dataset can be complete-but-wrong or incomplete-but-correct; these are tracked
as separate axes, not conflated into one score.

## 5. To produce the numeric coverage report

1. Add a `provider` column to `CandleBar` (additive migration) so provider
   distribution is queryable.
2. Build the coverage-matrix query (group by instrument, interval, day; join
   against the NSE trading calendar to compute *expected* intervals).
3. Add the `DataGap` ledger so missing intervals are recorded, not just logged.
4. Run the reconciliation job (brief §42) to fill in real counts.

Until (1)–(4) exist, any numeric coverage claim would be fabricated, which the
brief forbids. Status: **DATA_INSUFFICIENT for numeric coverage certification.**
