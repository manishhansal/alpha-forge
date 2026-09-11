# ALPHAFORGE — DATA FOUNDATION V3 FINAL REPORT

Companion reports: `ALPHAFORGE_DATA_V3_BASELINE.md`,
`ALPHAFORGE_DATA_V3_ROOT_CAUSE_REPORT.md`,
`ALPHAFORGE_DATA_V3_COVERAGE_REPORT.md`,
`ALPHAFORGE_DATA_PROVIDER_RUNTIME_REPORT.md`, `ALPHAFORGE_DATA_GAP_REPORT.md`,
`ALPHAFORGE_DATA_OPTION_COVERAGE_REPORT.md`.

**Bottom line.** The V3 data pipeline — provider capability matrix, real
provider observations, deduplicated data-quality incidents, durable gap
detection + recovery, higher-timeframe aggregation, provenance stamping +
deterministic dataset versioning, a resumable/idempotent backfill orchestrator,
write-through persistence, and a capability-specific readiness contract — is
built, tested, and **executed against the real Postgres**. The previously-empty
durable tables now hold **real** rows. No market data was fabricated. No ML /
signal / A+ / EV / profitability / threshold code was touched.

The single hard limit is environmental: **no broker credentials** (`SMARTAPI_*`
and `UPSTOX_*` are unset), so the only provider that serves **multi-day intraday
history** cannot be exercised. Intraday coverage therefore remains **0** and is
reported **DATA_INSUFFICIENT** — the pipeline is ready to populate it the moment
a credentialed provider is configured, and it will never manufacture bars.

---

## 1. Evidence tiers (§59)

| Capability | Tier |
|---|---|
| Provider capability matrix | IMPLEMENTED + TEST-VERIFIED |
| ProviderObservation write path | IMPLEMENTED + DB-VERIFIED (`provider_observation=12`) |
| DataQualityIncident + dedup | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED (`data_quality_incident=2`, deduped across reruns) |
| Gap detection (no false gaps) | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED (RELIANCE 0 gaps) |
| Gap recovery + verify-before-resolve + correction | IMPLEMENTED + TEST-VERIFIED |
| 1m→HTF aggregation + lineage | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED |
| Provenance stamping + dataset versioning | IMPLEMENTED + DB-VERIFIED (demo 1,875 rows 100% stamped) |
| Backfill resume / idempotency / chunking | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED |
| Write-through intraday persistence | IMPLEMENTED + TEST-VERIFIED |
| Capability-specific readiness contract | IMPLEMENTED + DB-VERIFIED |
| Live data-service quote | LIVE-RUNTIME-VERIFIED (200 / 95 ms / null volume preserved) |
| Multi-day intraday acquisition | **DATA_INSUFFICIENT / LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** (no creds) |
| Broker failover drill | **LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** (no creds) |
| Daily-timestamp normalization (D-V3-04) | INVESTIGATED + tooling IMPLEMENTED; migration NOT APPLIED (needs approval) |

## 2. Final data readiness contract (machine-readable, §53)

```json
{
  "state": "DATA_INSUFFICIENT",
  "marketOpen": true,
  "capabilities": {
    "1d_equities": "DATA_READY",
    "1m_equities": "DATA_INSUFFICIENT",
    "3m_equities": "DATA_INSUFFICIENT",
    "5m_equities": "DATA_INSUFFICIENT",
    "15m_equities": "DATA_INSUFFICIENT",
    "30m_equities": "DATA_INSUFFICIENT",
    "1h_equities": "DATA_INSUFFICIENT",
    "index_options": "DATA_DEGRADED",
    "stock_options": "DATA_INSUFFICIENT"
  },
  "reasons": ["intraday_not_persisted:no_credentialed_history_provider",
              "index_options_aggregate_only", "stock_options_absent"],
  "unresolvedGaps": 0,
  "provenanceKnownOnHistoricalDaily": false
}
```

Can the signal engine operate on intraday? **No** (DATA_INSUFFICIENT). On daily?
**Yes** (DATA_READY, with the D-V3-04 duplicate caveat pending migration).

## 3. Verification (exact results, this pass)

- `tsc --noEmit` (app): **PASS** · `tsc -p worker/tsconfig.json`: **PASS**
- `prisma validate`: **PASS** · `prisma generate`: **PASS**
- `prisma migrate status`: pre-existing failed migration `20260909…` (out of data
  scope, unrelated; V3 added no migration) — flagged, untouched.
- `eslint` (all new/modified files): **0 problems**
- `vitest run` (full): **3,391 passed / 217 files** (incl. 31 new V3 tests; 0 regressions)
- `pytest` (data-service): **671 passed, 18 skipped**; `compileall`: clean
- Real DB probe: `candle_bar` 89,810 (unchanged); `provider_observation=12`,
  `data_quality_incident=2`, `data_gap=0`, `data_correction=0`.

## 4. End-to-end trace demonstrated (§58)

Provider(live quote) → ProviderObservation → normalization/validation
(volume-null preserved) → [for candles] provenance stamp → CandleBar persist
(idempotent, demo) → coverage → gap detection (0 false gaps) → readiness
(capability-specific) → global data gate vocabulary. Options: aggregate index
snapshot persisted; per-strike/stock DATA_INSUFFICIENT reported honestly.

## 5. What was explicitly NOT done (and why)
- **Daily-timestamp migration not applied** — mutating ~89.8k production rows is
  high-risk; the deterministic dry-run tool is provided and awaits operator
  approval.
- **No broker credentials configured** — cannot acquire real intraday history or
  run a live failover drill; reported, not fabricated.
- **No ML / signal / A+ / EV / profitability / threshold change.**
- **Pre-existing `20260909` migration drift** left for a separate reconciliation.
- **No destructive DB operation.**

## 6. Certification level

```
DATA_READY            — 1d equities/index (with D-V3-04 caveat)
DATA_DEGRADED         — index options (aggregate-only)
DATA_INSUFFICIENT     — all intraday intervals, stock options
LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE — broker history + failover (no creds)
OVERALL               — DATA_INSUFFICIENT
```

Not claimed: PRODUCTION READY (evidence for intraday + broker runtime is absent
by environment, not by omission). The pipeline is real and proven where the
environment allowed; the remaining gap is credentials + an operator-approved
daily-timestamp migration, both clearly documented.
