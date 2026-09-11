# ALPHAFORGE — V5 OPTION COVERAGE (REAL, DB-DERIVED)

Queried 2026-09-11. **Strike-level option data now exists** (new `OptionChainStrike`
table) — a step up from V4's aggregate-only snapshots.

## OptionChainStrike (new, real strike-level)

| underlying | rows | expiry | OI | IV | bid/ask | volume | provider |
|---|---|---|---|---|---|---|---|
| NIFTY | 364 | 15-Sep-2026 | **real** | NULL (unavailable) | NULL (unavailable) | NULL | angel_one |
| BANKNIFTY | 580 | 29-Sep-2026 | **real** | NULL | NULL | NULL | angel_one |
| **Total** | **944** | | | | | | |

(Row counts reflect two capture runs at distinct `captureTimestamp`s — real
distinct snapshots, deduped by the unique key, not fabricated duplicates.)

Field availability (honest, §25/§27): Angel's option-chain synthesis supplies
per-strike **OI (real)** and LTP, but **NOT** IV / bid / ask / per-strike volume
— those are stored NULL with `*Unavailable=true`, never fabricated to 0. A
provider that supplies full greeks (Upstox `/v2/option/chain` with `expiry_date`,
or Angel `optionGreek`) would populate IV/bid/ask; that path returned HTTP 400
without an explicit expiry this pass and is a follow-up.

## OptionChainSnapshot (legacy aggregate) — unchanged
~2,941 aggregate index snapshots (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY), last
2026-09-10. Aggregate analytics only.

## Stock options
0 stock-option strike rows. The `data:options` command + `OptionChainStrike`
model support them; a `--underlyings=RELIANCE,HDFCBANK,…` run acquires them
(Angel synthesises stock chains from the NFO scrip master). Not run this pass →
**DATA_INSUFFICIENT** for stock options, honestly.

## Status
```
Index options (strike-level OI)   DATA_DEGRADED  (real OI; IV/bid/ask unavailable via current path)
Index options (IV/bid/ask)        DATA_INSUFFICIENT (needs greeks endpoint)
Stock options                     DATA_INSUFFICIENT (0 rows; mechanism ready)
```
