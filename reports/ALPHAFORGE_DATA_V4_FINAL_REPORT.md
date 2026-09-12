# ALPHAFORGE — DATA FOUNDATION V4 FINAL REPORT

Companion reports: `ALPHAFORGE_DATA_V4_BASELINE.md`,
`ALPHAFORGE_DAILY_NORMALIZATION_PLAN_V4.md`,
`ALPHAFORGE_DATA_V4_ROOT_CAUSE_REPORT.md`,
`ALPHAFORGE_DATA_V4_INTRADAY_REPORT.md`, `ALPHAFORGE_DATA_V4_OPTION_REPORT.md`,
`ALPHAFORGE_DATA_V4_PROVIDER_REPORT.md`, `ALPHAFORGE_DATA_V4_GAP_REPORT.md`.

**Bottom line.** V4 turned the daily-integrity defect from a vague flag into a
fully-characterised, evidence-based, safe-to-apply normalization plan; added a
structural canonical `sessionDate` key for forward daily uniqueness; removed
demo contamination from provider reliability; built honest config-health,
sample-size-aware reliability, and a runtime-vs-static capability matrix; ran
full-universe daily gap detection (245 real gaps); delivered a fail-closed
data-gate enforcement surface; and safely resolved the long-standing migration
drift. No market data was fabricated. No ML/signal/threshold code was touched.

The hard limit is unchanged and environmental: **no broker credentials + market
closed**, so real intraday acquisition, broker runtime, broker failover, and F&O
strike capture remain **NOT_VERIFIED / DATA_INSUFFICIENT** — reported honestly.

---

## 1. Evidence tiers

| Capability | Tier |
|---|---|
| Daily integrity analysis + normalization plan | DB-VERIFIED (analysis) + IMPLEMENTED (tooling, dry-run) |
| Canonical `sessionDate` model + partial unique index | DB-VERIFIED (migration applied) |
| Migration drift `20260909` resolution | DB-VERIFIED (status clean) |
| Demo-contamination purge | DB-VERIFIED (11 removed, 1 real remains) |
| Config-health service (no secrets) | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED |
| Provider reliability + sample-size honesty | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED (INSUFFICIENT_SAMPLE) |
| Runtime-aware capability matrix | IMPLEMENTED + TEST-VERIFIED + DB-VERIFIED (all NOT_VERIFIED) |
| Data-gate enforcement helper (fail-closed) | IMPLEMENTED + TEST-VERIFIED; NOT wired to live trading |
| Full-universe daily gap detection | DB-VERIFIED (245 rows, 175 instruments) |
| Provenance on new writes + sessionDate | IMPLEMENTED |
| Intraday acquisition | DATA_INSUFFICIENT / LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE |
| Angel/Upstox/Yahoo runtime + failover | NOT_VERIFIED (no creds / market closed) |
| Index/stock option strike-level history | DATA_DEGRADED / DATA_INSUFFICIENT (designed, not fabricated) |

## 2. Verification (exact, this pass)
- `tsc --noEmit` app: **PASS** · worker: **PASS**
- `prisma validate`: **PASS** · `prisma migrate status`: **"Database schema is up to date!"**
- `eslint` (new/modified files): **0 problems**
- `npm run build`: **PASS** (prebuild ran the full test suite)
- `vitest run` (full): **3,407 passed / 218 files** (+16 V4; 0 regressions)
- `pytest` (data-service): **664 passed, 25 skipped**; `compileall`: clean
- Real DB probe (2026-09-11T10:50Z): CandleBar 89,810; `data_gap=245`,
  `data_quality_incident=2`, `provider_observation=1`, `data_correction=0`;
  provenance 0/89,810 (historical, unchanged by design).

## 3. Blocker table (§82 — real current values)

| Issue | Severity | Current state | Evidence | Blocks production? |
|---|---|---|---|---|
| Intraday history | Critical | DATA_INSUFFICIENT | 0 persisted (all intervals) | YES |
| Daily duplicates | Critical | OPEN (plan+tool ready, not applied) | 3,442 VALUE_CONFLICT days | YES |
| Weekend daily bars | High | OPEN (quarantine planned) | 1,029 | YES |
| Non-canonical daily rows | High | OPEN (sessionDate for new writes) | 4,921 | YES |
| Stock options | Critical | DATA_INSUFFICIENT | 0 snapshots | YES |
| Index options | High | DATA_DEGRADED | aggregate-only, 0 per-strike | YES (for F&O strategies) |
| Broker runtime (Angel/Upstox) | High | NOT_VERIFIED | no credentials | YES |
| Broker failover drill | High | NOT_VERIFIED | no credentials | YES |
| Historical provenance | Medium | UNKNOWN | 0/89,810 | Depends |
| Data gaps (daily) | Medium | DETECTED (245), recovery pending | full-universe run | YES for full cert |
| Data-gate enforcement | High | Surface built, not wired | 0 prod call sites of V2 gate | YES for enforcement cert |
| Provider reliability sample | Medium | INSUFFICIENT_SAMPLE | 1 real observation | YES for reliability cert |
| Migration drift 20260909 | Medium | **RESOLVED** | migrate status clean | NO |

## 4. Final decision (§83)

| Question | Answer | Evidence |
|---|---|---|
| Consume daily equity data safely? | **PARTIAL** | ~100% per-trading-day coverage, but 3,442 duplicate + 1,029 weekend rows unresolved until migration applied |
| Consume intraday data safely? | **NO** | 0 persisted rows (DATA_INSUFFICIENT) |
| Consume index options safely? | **PARTIAL** | aggregate analytics only; no per-strike history |
| Consume stock options safely? | **NO** | 0 snapshots (DATA_INSUFFICIENT) |
| Survive provider failure? | **NOT_VERIFIED** | classification/failover coded + unit-tested; no live drill (no creds) |
| Detect data gaps? | **PARTIAL (YES for daily)** | 245 real daily gaps DB-VERIFIED; intraday not detectable |
| Recover data gaps? | **NOT_VERIFIED** | recovery TEST-VERIFIED; needs credentialed re-fetch |
| Prove provenance? | **PARTIAL** | forward writes stamped; historical UNKNOWN (0/89,810) |
| Enforce DATA_BLOCKED? | **PARTIAL** | enforcement helper fail-closed + TEST-VERIFIED; not wired to all live paths |
| Run intended Indian F&O strategies? | **NO** | intraday + stock/index-strike data insufficient |

## 5. What was explicitly NOT done (and why)
- **Daily normalization not applied** — high-risk mutation of ~89.8k rows;
  3,442 conflicts need a credentialed provider to resolve authoritatively.
  Dry-run tool + plan delivered; awaits operator approval.
- **Data-gate not wired into live trading** — would halt trades; requires
  operator decision. Fail-closed helper + tests delivered as the migration surface.
- **No broker credentials** — Angel/Upstox runtime, failover, intraday backfill,
  F&O strike capture all NOT_VERIFIED; never fabricated.
- **No ML/signal/A+/EV/profitability/threshold change.** No destructive DB op.
- **No empty strike-level table created** — would be code without data (§85);
  the model is designed in the option report, to be added when a provider fills it.

## 6. Certification
```
DATA_READY            — (none unconditionally; daily is READY-grade only after normalization)
DATA_DEGRADED         — index options (aggregate-only); daily equity (pending duplicate/weekend cleanup)
DATA_INSUFFICIENT     — all intraday intervals; stock options
DATA_BLOCKED          — (enforceable via new helper; not yet wired to all producers)
LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE — Angel/Upstox runtime, broker failover, F&O strike capture
OVERALL               — DATA_INSUFFICIENT (for the intended F&O strategy set)
```
PRODUCTION READY is **not** claimed. Per §84, do not proceed to ML/signal
optimization: the required intraday + F&O data is DATA_INSUFFICIENT, and the
daily set needs the operator-approved normalization before it is trustworthy.
