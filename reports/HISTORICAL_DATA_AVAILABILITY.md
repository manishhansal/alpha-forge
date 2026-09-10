# HISTORICAL DATA AVAILABILITY (Phase 8)

**Date:** 2026-09-09 · Read-only inspection. Provider chain preserved
(data-service → Angel One → Upstox → Yahoo); **no direct NSE**; no data fabricated.

## What was inspected

- Persisted stores in the local DB (`localhost:5433`, `crypto_dashboard`): `candle_bar`,
  `PaperTrade` (India rows `source LIKE 'in:%'`).
- Provider historical capabilities (from `registry`/`historical.service`): daily
  OHLCV via Yahoo (guaranteed), Angel One / Upstox (credential-gated), option chain
  via Angel One / Upstox (live only — NSE has no history endpoint).
- Prior audit finding **RCA-001**: intraday candles were never persisted across
  sessions.

## Findings

| Source | Status | Usable for multi-session replay? |
|---|---|---|
| `candle_bar` (intraday 1m/5m/15m) | Table exists; **not durably populated across sessions (RCA-001)** | ❌ No |
| Daily OHLCV (Yahoo, 1y) | Fetchable live + now persisted fire-and-forget by `computeIndiaUniverse` | ⚠️ daily only; no intraday |
| `option_chain_snapshot` | **Absent in this DB** (schema ahead of DB); snapshot-cadence only, no history endpoint | ❌ No |
| India `PaperTrade` (`in:` rows) | Exists; effectively a **single real session** (the 2026-09-01 ledger) | ❌ Not multi-session |
| OI / IV / Greeks history | Not persisted (snapshot-only) | ❌ No |

## Verdict

> ## HISTORICAL REPLAY BLOCKED — INSUFFICIENT DATA

There is **no multi-session intraday history** and **no persisted option-chain
history** to replay. Only daily OHLCV is broadly available, and the strategies trade
intraday (1m/5m/15m), so a faithful chronological replay of the real signal engine is
**not possible today**. Producing replay-based Quality→profitability, probability
calibration, or grade-monotonicity numbers would require **fabricating history**,
which is explicitly forbidden.

## Unblock path (the correct, non-fabricated route)

1. The remediation already added durable `IndiaPredictionRecord` / `IndiaResolutionRecord`
   and wired `PrismaSignalRecordStore` into the shadow path — so **going forward**,
   every shadow-evaluated signal can persist an immutable prediction + resolution.
2. Fix RCA-001 (persist intraday `candle_bar` every session) so intraday replay
   becomes possible.
3. Accumulate ≥ N live PAPER sessions; only then run Phase 9/10 replay + walk-forward
   on **real** persisted data.

Until then, all replay-dependent validations are honestly reported as
**INSUFFICIENT EVIDENCE**, not estimated.
