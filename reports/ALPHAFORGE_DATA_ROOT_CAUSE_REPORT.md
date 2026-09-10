# ALPHAFORGE — DATA ROOT-CAUSE REPORT

Companion to `ALPHAFORGE_DATA_FORENSIC_AUDIT.md`. Each issue follows the brief's
RCA structure: symptom → immediate cause → underlying cause → architectural
cause → permanent fix, with evidence and status.

Status legend: **FIXED** (changed + verified in this pass) · **INFRA** (needs
new infrastructure / future work, scoped here) · **POLICY** (needs a human
decision) · **OPEN**.

---

## RCA-D01 — Missing option OI/volume fabricated as `0` (Upstox, TS)

- **Symptom:** Option-chain analytics (PCR, max-pain, OI walls) are produced even
  when the provider omitted OI, because absent OI reads as a real `0`.
- **Evidence:** `src/lib/market-data/providers/upstox.ts` `normaliseOptionLeg`:
  `const oi = md.oi ?? 0;`, `oiChange = prevOi != null ? oi - prevOi : 0;`,
  `volume: md.volume ?? 0`. `computeAnalytics` sums these into `totalCeOi`, PCR,
  max-pain.
- **Immediate cause:** `?? 0` / `: 0` defaults on nullable fields.
- **Underlying cause:** `OptionContract.oi` and `.volume` are typed as
  non-nullable `number`, forcing a default when the source is null.
- **Architectural cause:** No distinction between "0 contracts" and "unknown".
  The type system encodes the fabrication.
- **Permanent fix:** make missing OI/volume/oiChange explicit. Because
  `OptionContract.oi/volume` are non-nullable across the codebase (widely
  consumed), the safe, low-blast-radius fix is: (a) keep a real `0` only when the
  source truly sent `0`; (b) when the source omitted the field, mark the leg via
  a new optional `oiMissing`/`volumeMissing` provenance flag and **exclude
  missing legs from analytics sums** rather than adding fabricated zeros. This is
  the change applied — see `REMEDIATION_CHANGELOG.md`.
- **Status:** **FIXED** (analytics no longer sum fabricated zeros; missing flags
  added).

## RCA-D02 — Missing option OI/volume fabricated as `0` (Python data-service)

- **Symptom:** Same as D01 but in the canonical gateway.
- **Evidence:** `data-service/src/scrapers/option_chain.py` `_build_option_contract`:
  `oi=int(raw.get("openInterest", 0))`, `oiChange=int(raw.get("changeinOpenInterest", 0))`,
  `volume=int(raw.get("totalTradedVolume", 0))`; identical in `_bse_to_contract`.
- **Immediate cause:** `.get(key, 0)` default.
- **Underlying cause / architectural cause:** as D01, in Python.
- **Permanent fix:** distinguish present-`0` from absent. Preserve `None` when the
  raw key is absent (mirroring the greeks' `... or None` pattern that is already
  correct here). Applied.
- **Status:** **FIXED**.

## RCA-D03 — Delayed / polled quotes stamped with a live timestamp

- **Symptom:** A ~15-min-delayed Yahoo quote and a REST-polled scrapling quote
  pass the 5s liveness check as if fresh.
- **Evidence:** `providers/yahoo.ts` `subscribe`:
  `exchangeTimestampMs: Date.now(), receivedAtMs: Date.now()`;
  `providers/scrapling.ts` polling subscribe stamps `exchangeTimestampMs: now`.
- **Immediate cause:** `Date.now()` used for the *exchange* timestamp when no true
  exchange timestamp exists.
- **Underlying cause:** Polling adapters have no exchange-side timestamp, but the
  `LiveTick` contract requires one, so `now()` is substituted.
- **Architectural cause:** `LiveTick` cannot express "this is a polled/delayed
  quote; treat its recency accordingly." There is no per-provider feed-latency
  declaration.
- **Permanent fix:** stop stamping `exchangeTimestampMs = now()` for delayed feeds.
  Add a `synthetic: true` / feed-delay marker on the tick so the staleness check
  can subtract the known provider delay and never treat delayed data as fresh.
  Applied for Yahoo (known-delayed) and the scrapling polling path.
- **Status:** **FIXED** (marker added; delayed feeds no longer report a
  fresh exchange timestamp).

## RCA-D04 — `filterValidCandles` silently drops candles with no report

- **Symptom:** Invalid / out-of-order candles vanish; callers cannot tell how
  many, or why.
- **Evidence:** `validation/candle-validator.ts` `filterValidCandles` returns a
  bare `OHLCVCandle[]`.
- **Immediate cause:** Function returns only the kept candles.
- **Underlying/architectural cause:** No structured drop report threaded to the
  caller; "clean" and "silently repaired" are indistinguishable.
- **Permanent fix:** add a sibling `filterValidCandlesWithReport` that returns
  `{ candles, dropped: [{index, error}] , droppedCount }` **without changing the
  existing signature** (so no consumer breaks), and have the historical service
  log the drop count. Applied (non-breaking, additive).
- **Status:** **FIXED** (additive reporting; existing callers unaffected).

## RCA-D05 — Provider outage swallowed into `[]` (indistinguishable from no-data)

- **Symptom:** `getHistoricalCandles` returns `[]` on a total provider failure,
  identical to "genuinely no candles in range."
- **Evidence:** `services/historical.service.ts` `catch { return []; }`;
  `services/instrument-master.service.ts` swallow → `[]`.
- **Immediate cause:** broad `catch` returning empty.
- **Underlying cause:** the service contract is a bare array with no way to say
  `PROVIDER_FAILED` vs `AVAILABLE(empty)`.
- **Architectural cause:** missing DataAvailability envelope (audit §4).
- **Permanent fix (scoped, non-breaking):** keep the array-returning functions for
  compatibility, but add an explicit `getHistoricalCandlesWithStatus` that returns
  `{ candles, status, provider, error }` distinguishing `PROVIDER_FAILED` from
  `AVAILABLE`. Log the distinction on the swallow path so outages are observable
  now. Applied: logging added on the swallow path (immediate observability);
  full envelope API is **INFRA** (documented in the readiness certification).
- **Status:** **PARTIAL** — observability FIXED; typed-status API is **INFRA**.

## RCA-D06 — Data-quality / provenance engine not wired into read paths

- **Symptom:** Default reads carry no quality/completeness/staleAge.
- **Evidence:** `reconciliation.service.ts` is complete but only runs when a caller
  invokes `reconcileTick`/`reconcileCandle`/`evaluateSignalGate`; the read
  services return bare types.
- **Root cause:** the envelope was built as an opt-in utility, not the default
  return shape.
- **Permanent fix:** this is a cross-cutting API change (attach `QualityEnvelope`
  to every read). Large blast radius; scoped as **INFRA** with a concrete design
  in the readiness certification. Not attempted blindly in this pass to avoid
  destabilising every consumer.
- **Status:** **INFRA**.

## RCA-D07 — No persisted data-gap / incident / raw-observation / version models

- **Symptom:** Gaps, quality incidents, raw-vs-normalized observations, and
  dataset versions are not durably recorded (Prisma has none; Python lineage is
  in-memory only).
- **Evidence:** `prisma/schema.prisma` (no `DataGap`/`DataQualityIncident`/
  `ProviderObservation`/`DataCorrection`); `core/lineage.py` is a bounded
  in-memory LRU.
- **Root cause:** persistence model predates the data-reliability requirements.
- **Permanent fix:** additive, non-destructive Prisma migration adding the models
  (brief §26/27/42/44). Scoped as **INFRA** with the exact model definitions in
  the readiness certification; a migration is **not** run here because it touches
  the production schema and must be reviewed (safety guardrail — schema change).
- **Status:** **INFRA** (design provided; migration awaits review).

## RCA-D08 — Documentation claims contradict direct-scraping reality

- **Symptom:** `brokers/__init__.py` says "Neither client performs any direct NSE
  data acquisition," but the data-service scrapes NSE/BSE directly.
- **Evidence:** `live_quotes.py`, `option_chain.py`, `historical.py`,
  `instrument_master.py` all hit `nseindia.com` / `bseindia.com` directly.
- **Root cause:** comment drift after the acquisition strategy changed.
- **Permanent fix:** correct the comment to describe actual behaviour; confirm the
  policy (Rule 10 forbids *TypeScript* NSE scraping — the data-service acquisition
  layer is a separate policy question).
- **Status:** **POLICY** (comment correction applied; acquisition policy is a
  human decision).

## RCA-D09 — Weaker OHLC validation on the Upstox Python candle path

- **Symptom:** An internally-crossed candle (e.g. `high < open`) can pass.
- **Evidence:** `upstox_client.py`: `if candle.high < candle.low or candle.open <= 0 or candle.close <= 0: continue` — omits `high >= max(open, close)` and `low <= min(open, close)`.
- **Root cause:** inline validation weaker than the canonical `_validate_candle_row`.
- **Permanent fix:** route Upstox candles through the same full invariant check.
  Applied.
- **Status:** **FIXED**.

---

## Summary

| RCA | Severity | Status |
|---|---|---|
| D01 Upstox option OI/vol `?? 0` | High | FIXED |
| D02 Python option OI/vol `,0` | High | FIXED |
| D03 delayed quote stamped live | High | FIXED |
| D04 silent candle drop | Medium | FIXED (additive) |
| D05 outage → `[]` | Medium | PARTIAL (obs FIXED, API INFRA) |
| D06 quality envelope not wired | High (arch) | INFRA |
| D07 no gap/incident/version models | High (arch) | INFRA |
| D08 doc drift | Low | POLICY (comment fixed) |
| D09 weak Upstox candle check | Medium | FIXED |

No ML, signal-threshold, or A+/grade code was modified. No historical data was
fabricated. No missing value was converted to `0` — the fixes move in the
opposite direction (removing existing fabrications).
