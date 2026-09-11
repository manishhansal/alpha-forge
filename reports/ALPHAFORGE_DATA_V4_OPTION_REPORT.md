# ALPHAFORGE — DATA FOUNDATION V4 OPTION REPORT

Real DB state, queried 2026-09-11 (`scripts/data-v4-option-coverage.ts`).

## 1. Index options (aggregate-only)

| underlying | snapshots | first | last | per-strike OI/IV/bid/ask | status |
|---|---|---|---|---|---|
| NIFTY | 736 | 2026-06-16 | 2026-09-10 | **none persisted** | DATA_DEGRADED |
| BANKNIFTY | 736 | 2026-06-16 | 2026-09-10 | none | DATA_DEGRADED |
| FINNIFTY | 738 | 2026-06-16 | 2026-09-10 | none | DATA_DEGRADED |
| MIDCPNIFTY | 731 | 2026-06-16 | 2026-09-10 | none | DATA_DEGRADED |

**DB-VERIFIED finding:** the NIFTY snapshot `analytics` JSON blob contains ONLY
aggregate keys (`atmIv`, `pcrOi`, `maxPain`, `pcrVolume`, `totalCeOi/PeOi`,
`totalCeOi/PeOiChange`, `maxCeOiStrike`, `maxPeOiStrike`).
`arrayCandidatesForStrikes: []` — there is **no per-strike array at all**.
Therefore strike/CE/PE/OI/IV/bid/ask **completeness cannot be computed** because
none is persisted. Aggregate-only ⇒ **DATA_DEGRADED**, never DATA_READY (§27).

Note: option-chain capture last ran 2026-09-10 (the `india-oc-capture` worker is
not currently running).

## 2. Stock options

```
Underlying        (none)
Snapshots         0
OI/IV/bid/ask/vol n/a
Historical depth  0
Status            DATA_INSUFFICIENT
```

The true F&O stock universe requires an instrument-master refresh from a
credentialed provider (Angel/Upstox), which is not available here. Never
fabricate stock-option fields (Rule 24 / §1).

## 3. Strike-level model design (§25/§26 — designed, not fabricated)

Proposed durable table (to be added + populated ONLY when a credentialed
provider supplies real per-strike data — NOT created empty this pass, per §85
"no more code without real data"):

```
OptionChainStrike {
  underlying, expiry, strike, optionType (CE|PE),
  ltp, bid, ask, volume, oi, oiChange, iv,
  captureTimestamp, sourceTimestamp, receivedAt, provider, datasetVersion
  @@unique([underlying, expiry, strike, optionType, captureTimestamp, provider])
}
```

Uniqueness key (§26): `(underlying, expiry, captureTimestamp, provider)` at the
snapshot level and `(…, strike, optionType)` at the row level. Any field the
provider does not supply stays `null` with an explicit `*Missing` flag (reusing
the V1/V2 option provenance flags) — never defaulted to 0.

## 4. Option provider failover (§29)
Capability-aware: Angel/Upstox option-chain first; Yahoo is NOT a valid option
fallback (no OI/IV/bid/ask) and is excluded from the option chain. Cannot be
runtime-verified without credentials → **NOT_VERIFIED**.

## 5. Verdict
- Index options: **DATA_DEGRADED** (aggregate-only, no per-strike history).
- Stock options: **DATA_INSUFFICIENT** (0 snapshots).
- Strike-level capture: **NOT_VERIFIED** (needs a credentialed provider).
