# ALPHAFORGE — DATA ROOT-CAUSE REPORT V2

Companion to `ALPHAFORGE_DATA_V2_BASELINE.md`. Covers the issues addressed in the
V2 program (Data Foundation V2). Each follows: symptom → evidence → immediate
cause → underlying cause → architectural cause → permanent fix → tests → status
→ residual risk.

Status legend: **FIXED** (changed + verified) · **INFRA** (infrastructure built,
population/rollout pending) · **NEEDS-VERIFY** · **POLICY**.

---

## D-V2-01 — Empty array / null hides provider failure & insufficient history

- **Symptom:** A total provider outage and "genuinely no data" both returned
  `[]`; `getQuotes` returned all-`null` indistinguishable from unresolved symbols.
- **Evidence:** `historical.service` `catch { return [] }`; `instrument-master`
  `catch { return [] }`; `registry.getQuotes` → `Array(n).fill(null)`.
- **Immediate cause:** bare array/null return type with no status channel.
- **Underlying/architectural cause:** no data-availability contract; the read
  surface could not express *why* a result was empty.
- **Permanent fix:** `DataAvailability<T>` contract
  (`data-availability.ts`) + non-breaking `*WithStatus` reads
  (`read-with-status.service.ts`): `getHistoricalCandlesWithStatus`,
  `getQuotesWithStatus` (per-symbol `reason`), `getInstrumentsWithStatus`,
  `getOptionChainWithStatus`. Errors mapped via `classifyError` →
  `PROVIDER_FAILED` / `AUTH_FAILED` / `RATE_LIMITED` / `INVALID` /
  `INSUFFICIENT_HISTORY` / `UNAVAILABLE`. Legacy functions untouched.
- **Tests:** `data-foundation-v2.test.ts` — error→status mapping, typed
  MarketDataError classification.
- **Status:** **FIXED** (contract + APIs). Consumer migration to the new APIs is
  incremental (INFRA — signal engine first).
- **Residual risk:** existing callers still use the legacy `[]`-returning
  functions until migrated; behaviour there is unchanged (safe).

## D-V2-02 — No first-class INSUFFICIENT_HISTORY on the read path

- **Symptom:** a short candle series was indistinguishable from a full one.
- **Fix:** `getHistoricalCandlesWithStatus({minBars})` returns
  `INSUFFICIENT_HISTORY`; `checkHistorySufficiency()` in `coverage.service.ts`
  returns `AVAILABLE / INSUFFICIENT_HISTORY / PARTIAL / INVALID` with
  `requiredBars / availableBars / missingBars`.
- **Status:** **FIXED**.

## D-V2-03 — No durable gap / incident / raw-evidence / correction models

- **Evidence:** `prisma/schema.prisma` had none; Python lineage in-memory only.
- **Fix:** additive migration `20260910000000_data_foundation_v2` adds
  `DataGap`, `DataQualityIncident`, `ProviderObservation`, `DataCorrection`
  (+ indexes) and 5 nullable/defaulted provenance columns on `CandleBar`.
  Applied to the local dev DB (verified: 4 tables + 5 columns created) and
  recorded via `prisma migrate resolve`.
- **Status:** **INFRA** (tables live; write paths populate them going forward).
- **Residual risk:** tables are currently empty; the detection/recovery and
  raw-capture write paths that fill them are the next build step.

## D-V2-04 — Snapshot cross-field time skew not gated

- **Fix:** `evaluateSnapshotConsistency()` (`data-gate.ts`) →
  `DATA_SNAPSHOT_INCONSISTENT` when critical-field skew > 60s (configurable).
- **Status:** **FIXED** (function + tests). Wiring into the signal snapshot
  builder is the consumer-migration step.

## D-V2-05 — Candle provenance absent

- **Evidence:** `CandleBar` had no `provider` column (coverage report V2:
  `candlesWithProvider = 0/89,810`).
- **Fix:** provenance columns added; `candle-persist.service` now accepts
  `provider`/`datasetVersion` opts and stamps `receivedAt`.
- **Status:** **INFRA** — schema ready; callers must pass `provider` to backfill
  it going forward (existing rows keep null, by design — never fabricated).

## D-V2-06 — Delayed/stale ticks could reach consumers unmarked (G-10)

- **Fix:** `LiveTick` gains `stale`/`staleAgeMs`; `live-feed.service` stamps them
  when `allowStaleTicks` forwards a stale tick. Combined with the V1
  `synthetic`/`feedDelayMs`, a consumer can never mistake delayed data for live.
- **Status:** **FIXED**.

## D-V2-07 — volume=0 placeholder vs genuine zero (G-06/G-07)

- **Fix:** `volumeUnavailable` flag on TS + Python `OHLCVCandle` (+ `CandleBar`
  column). Set by `normaliseCandlesFromAngel`, `normaliseCandlesFromUpstox`,
  Yahoo candle map, and the Python synthesized-intraday path
  (`_aggregate_price_series`). Persistence stores it.
- **Status:** **FIXED**.
- **Residual (SAFE-with-note):** the live `RealTimeCandleBuilder` opens a candle
  at `volume: tick.volume ?? 0` and accumulates; this is a genuine running total
  starting at 0, not a fabricated historical zero, so it is left as-is.

## D-V2-08 — Scrapling gateway data trusted without local validation (finding M)

- **Fix:** `scrapling.getHistoricalCandles` now runs
  `filterValidCandlesWithReport` locally and logs drops before the data enters
  the canonical layer.
- **Status:** **FIXED**.

## D-V2-09 — No intraday candle persistence (real coverage gap)

- **Evidence (real DB):** `candle_bar` is 100% `1d`; **0** intraday rows.
- **Immediate cause:** intraday history is fetched live and never written to
  `CandleBar`.
- **Fix path:** a backfill orchestrator + write-through on intraday reads
  (V2 Phase 16). Designed, **not built** in this pass.
- **Status:** **INFRA / DATA_INSUFFICIENT for intraday**. NOT fabricated.

## D-V2-10 — Daily candle timestamps at odd intra-day epochs

- **Evidence:** daily `CandleBar.time` at `03:45Z`/`13:00Z` rather than a
  normalized session date.
- **Status:** **NEEDS-VERIFY** — does not corrupt the calendar-aware row count
  (coverage counts rows per trading day), but daily-bar timestamp normalization
  should be confirmed. Tracked; not changed (would need to verify no consumer
  depends on the current value).

---

## Summary

| ID | Severity | Status |
|---|---|---|
| D-V2-01 empty/null ambiguity | High | FIXED (contract+APIs) |
| D-V2-02 INSUFFICIENT_HISTORY | High | FIXED |
| D-V2-03 durable models | High (arch) | INFRA (live, empty) |
| D-V2-04 snapshot skew gate | High | FIXED |
| D-V2-05 candle provenance | Med | INFRA |
| D-V2-06 stale tick propagation | High | FIXED |
| D-V2-07 volume unavailable | Med | FIXED |
| D-V2-08 scrapling validation | Med | FIXED |
| D-V2-09 no intraday persistence | High (coverage) | INFRA / DATA_INSUFFICIENT |
| D-V2-10 daily timestamp shape | Low | NEEDS-VERIFY |

No ML / signal-threshold / A+ / profitability code was modified. No data or
coverage number was fabricated.
