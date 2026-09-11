# ALPHAFORGE — DATA OPTION COVERAGE REPORT (V3, REAL)

DB-derived from `OptionChainSnapshot`, queried 2026-09-10T07:39Z.

---

## 1. Index options

| underlying | snapshots | first | last | OI | IV | bid/ask | volume | historical depth |
|---|---|---|---|---|---|---|---|---|
| NIFTY | 736 | 2026-06-16 | 2026-09-10 | aggregate | aggregate (atmIv) | ✗ | aggregate | ~3 months |
| BANKNIFTY | 736 | 2026-06-16 | 2026-09-10 | aggregate | aggregate | ✗ | aggregate | ~3 months |
| FINNIFTY | 738 | 2026-06-16 | 2026-09-10 | aggregate | aggregate | ✗ | aggregate | ~3 months |
| MIDCPNIFTY | 731 | 2026-06-16 | 2026-09-10 | aggregate | aggregate | ✗ | aggregate | ~3 months |

Only **aggregate analytics** are persisted (`pcrOi`, `pcrVolume`, `maxPain`,
`atmIv`, `totalCeOi/PeOi`, `+change`, plus the full `analytics` JSON blob).
**No per-strike OI/IV/bid/ask time series** is stored.

- **Completeness:** cannot be scored per-strike (no expected-strike baseline
  persisted). Aggregate cadence is captured by `india-oc-capture` during sessions.
- **Readiness: DATA_DEGRADED** for index options — aggregate-only means the full
  option contract (per-strike OI/IV/bid/ask) is not DATA_READY.

## 2. Stock options

```
Underlying        (none persisted)
Snapshots         0
OI / IV / bid/ask / volume   n/a
Historical depth  0
Readiness         DATA_INSUFFICIENT
```

No stock-option chains are snapshotted. Per §25/§52 this is reported
**DATA_INSUFFICIENT**, not DATA_READY.

## 3. Provider limitation (honest, §25)
Per-strike history and stock-option capture require a provider that serves the
full chain with OI/IV/bid/ask. The current durable path (`india-oc-capture`)
snapshots aggregate index analytics only. Angel One / Upstox option-chain
capture is available in the provider layer but **unusable here (no
credentials)**, so per-strike/stock-option history cannot be captured in this
environment. Never fabricate OI/IV/bid/ask (Rule 24) — unavailable fields stay
`null` with an explicit flag.

## 4. Never-fabricated fields
The V1/V2 `oiMissing`/`ivMissing`/`volumeMissing`/`oiChangeMissing` flags remain
in force; `getOptionChainWithStatus` counts only non-missing legs toward
completeness. A placeholder 0 is never treated as a real reading.
