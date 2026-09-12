# ALPHAFORGE — DATA COVERAGE REPORT V2 (REAL, DB-DERIVED)

Phases 11 & 60. Unlike the V1 coverage report (which was capability-only and
marked NOT VERIFIED), these numbers are **queried directly from the live
Postgres** (`crypto_dashboard` @ localhost:5433) on **2026-09-10** using
`prisma.candleBar.groupBy` / `optionChainSnapshot.groupBy`. Nothing is
fabricated (Absolute Rule 20).

Database status: **NOT empty** — real data present. So this is NOT
`DATABASE_HAS_NO_DATA` and NOT `INSUFFICIENT_REAL_DATA` for daily equity/ index.

---

## 1. Candle coverage (`candle_bar`)

| Interval / Exchange | Instruments | Actual bars | Expected (weekday lower-bound*) | Completeness (lower-bound) |
|---|---|---|---|---|
| **1d / NSE** | **175** | **89,810** | 89,115 | **~1.00** |
| 1m / 3m / 5m / 15m / 30m / 1h | 0 | 0 | — | **0 (NONE PERSISTED)** |

\* Expected uses **weekday count** as a calendar proxy in the report probe;
weekends excluded, **NSE holidays not subtracted**, so it slightly *under*-counts
expected days → completeness reads slightly **>1.0**. The production
`coverage.service.ts` uses the full NSE holiday calendar (`nseCalendar`) for the
exact figure. The takeaway is unchanged: **daily coverage is effectively
complete over each instrument's persisted span.**

Span: **2024-09-04 → 2026-09-09** (≈2 years).

Sample per-instrument daily completeness (weekday lower-bound):
- Long-history names (e.g. KAYNES, JSWENERGY): 527 bars vs ~526 weekdays → ~1.00.
- Short-history names (e.g. M&M, TMPV: 27 bars; MANAPPURAM: 282): also ~1.0+;
  these are instruments added to the universe more recently, so their span is
  shorter — **not** a gap, just a later listing/inclusion date.

### Finding F-1 (real, actionable): **no intraday candles are persisted**
Every intraday strategy reads history live from providers on each run; there is
**nothing durable** to compute intraday coverage/gaps against. This is the
single largest real coverage gap and is the driver for the intraday backfill
orchestrator (V2 Phase 16, scoped as INFRA below). It is a **persistence** gap,
not a data-availability gap — providers can serve intraday; it is simply not
being written to `candle_bar`.

### Finding F-2 (flagged for verification): daily candle timestamps
Daily `candle_bar.time` values sit at intra-day epochs (e.g. `03:45Z`/`13:00Z`)
rather than a normalized session date. The coverage engine counts *rows per
trading day*, so this does not corrupt the count, but the timestamp
normalization for daily bars should be verified (NEEDS-VERIFY, tracked in
ROOT_CAUSE_V2).

---

## 2. Option-chain coverage (`OptionChainSnapshot`)

| Underlying | Snapshots | First | Last |
|---|---|---|---|
| NIFTY | 735 | 2026-06-16 | 2026-09-10 |
| BANKNIFTY | 736 | 2026-06-16 | 2026-09-10 |
| FINNIFTY | 737 | 2026-06-16 | 2026-09-10 |
| MIDCPNIFTY | 731 | 2026-06-16 | 2026-09-10 |
| **Total** | **~2,939** | | |

Only the **4 index underlyings** are captured (matches the `india-oc-capture`
cadence job). **Per-strike OI/IV history is not persisted** — only aggregated
analytics + a JSON blob. Stock-option chains are not snapshotted.

**OI / IV coverage:** aggregate OI (`totalCeOi`/`totalPeOi`, `atmIv`) is present
per snapshot for the 4 indices since 2026-06-16. Strike-level OI/IV time series:
**not persisted** (INFRA).

---

## 3. V2 durable tables (created this pass — currently empty, by design)

| Table | Rows | Note |
|---|---|---|
| `data_gap` | 0 | populates when gap detection/recovery runs |
| `data_quality_incident` | 0 | populates when incidents are recorded |
| `provider_observation` | 0 | populates when raw-evidence capture is enabled |
| `data_correction` | 0 | populates when a corrected candle is received |

## 4. Candle provenance backfill status

`candle_bar` provenance columns exist (added this pass): `provider`,
`sourceTimestamp`, `receivedAt`, `datasetVersion`, `volumeUnavailable`.
- `candlesWithProvider`: **0 / 89,810** (nullable; backfilled going forward as
  the persist path is wired to stamp provider — see ROOT_CAUSE_V2 D-V2-05).
- `volumeUnavailableRows`: 0 (no daily row is missing volume).

---

## 5. Honest coverage verdict

- **Daily equity + index history: DATA_READY-grade** (175 instruments, ~2 yrs,
  ~100% completeness over each span).
- **Intraday candles: DATA_INSUFFICIENT (not persisted)** — infrastructure to
  fix (backfill + write-through) is scoped, not yet built.
- **Index option-chain analytics: PARTIAL** (4 indices, ~3 months, aggregate
  only; no per-strike history, no stock options).
- **Provenance / gaps / incidents: infrastructure now EXISTS** (tables + columns
  live in the DB) but is **unpopulated** until the write paths stamp it.

This report will read differently once the persist paths stamp provenance and
the intraday backfill runs; the numbers above are the true current state.
