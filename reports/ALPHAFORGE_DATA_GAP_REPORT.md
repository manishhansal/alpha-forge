# ALPHAFORGE — DATA GAP REPORT

Two senses of "gap" are covered: (A) **integrity gaps** in the code (silent
defaults, stale-as-live), and (B) **candle-continuity gaps** (missing intervals)
and the machinery that detects/recovers them.

---

## A. Integrity gaps (code-level)

| ID | Gap | Location | Class | Status |
|---|---|---|---|---|
| G-01 | Option OI `?? 0` (fabricated) | `providers/upstox.ts` `normaliseOptionLeg` | UNSAFE | **FIXED** |
| G-02 | Option oiChange `: 0` (fabricated) | same | UNSAFE | **FIXED** |
| G-03 | Option volume `?? 0` (fabricated) | same | UNSAFE | **FIXED** |
| G-04 | Option OI/oiChange/volume `,0` (Python) | `option_chain.py` NSE + BSE builders | UNSAFE | **FIXED** |
| G-05 | Analytics summed fabricated zeros | `upstox.ts` `computeAnalytics` + max-pain | UNSAFE | **FIXED** |
| G-06 | Candle volume `?? 0` | angel/yahoo candle map, persist | NEEDS-INVESTIGATION | **OPEN** (lower severity; volume-0 is often benign but should be flagged like OI) |
| G-07 | Intraday synthesized OHLC, `volume=0` | `historical.py` `_aggregate_price_series` | NEEDS-INVESTIGATION | **OPEN** (volume genuinely unavailable from that endpoint; must be surfaced, not silently 0) |
| G-08 | Delayed Yahoo tick stamped live | `providers/yahoo.ts` | UNSAFE | **FIXED** |
| G-09 | Polled scrapling tick stamped live | `providers/scrapling.ts` | UNSAFE | **FIXED** |
| G-10 | `allowStaleTicks` forwards stale w/o flag | `live-feed.service.ts` | UNSAFE | **OPEN** (needs `synthetic`/stale flag threaded to `onTick`; type now supports it) |
| G-11 | Silent candle drop (no report) | `candle-validator.ts` `filterValidCandles` | BUG | **FIXED** (added reporting variant) |
| G-12 | Provider outage → `[]` | `historical.service.ts`, `instrument-master.service.ts` | BUG | **PARTIAL** (historical now logs PROVIDER_FAILED; instrument-master still swallows) |
| G-13 | `getQuotes` catch → all-null | `angel-one.ts`, `upstox.ts` | BUG | **OPEN** (needs a typed failure marker vs unresolved-symbol null) |
| G-14 | Quality envelope not on read paths | services return bare types | ARCH | **OPEN / INFRA** (RCA-D06) |
| G-15 | Weak Upstox candle check | `upstox_client.py` | BUG | **FIXED** |

---

## B. Candle-continuity gaps (missing intervals)

### What exists
- **Session calendar:** `src/lib/india/nse-trading-calendar.ts` and
  `market-hours.ts` — so a missing candle during a holiday/closure is NOT
  mistaken for a data failure (brief §13). **GOOD.**
- **Reconnect gap-fill:** `RealTimeCandleBuilder.handleReconnect` requests the
  missing interval via a `backfillLoader`, validates, persists, and emits
  `CANDLE_CLOSE` for recovered candles (brief §11). On backfill failure it logs
  `backfill_failed` and continues.
- **Duplicate protection:** `CandleBar` unique key
  `(instrumentId, exchange, intervalStr, time)` — idempotent upsert; plus
  sequence-level `DUPLICATE_TIMESTAMP` / `TIMESTAMP_NOT_ASCENDING` detection.
- **OC-capture staleness alert:** `india-oc-capture.ts` warns when no option
  chain snapshot captured for >15 min during market hours (RCA-002 fix).

### What is missing (INFRA — see readiness certification)
- **No persisted gap ledger.** When `handleReconnect` cannot recover, the gap
  is logged but not stored, so `gapStart/gapEnd/duration/provider/recoveryStatus`
  (brief §12) are not queryable. Recommended: a `DataGap` Prisma model.
- **No coverage matrix.** There is no `instrument × date × timeframe × provider`
  table answering "do I have enough valid history for this feature" as data
  rather than an ad-hoc `[]` (brief §7/8). `UniverseCoverageSnapshot` covers
  F&O universe coverage per session but not per-instrument candle coverage.
- **No `INSUFFICIENT_HISTORY` result type** on the read path — a short series is
  indistinguishable from a full one at the service boundary (brief §8/79).

---

## C. Actual coverage counts — NOT VERIFIED

This report does not enumerate real candle counts / date ranges / missing
intervals per instrument, because that requires querying the live database and
providers, which was not executed in this pass. The forensic audit is
code-level. Populating real coverage numbers is the job of the reconciliation
job (brief §42) once the coverage matrix (above) exists. Marked
**NOT VERIFIED** to comply with the final certification rule (brief §88).
