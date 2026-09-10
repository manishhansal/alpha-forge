# REMEDIATION CHANGELOG

Every change made during the remediation is recorded here. Scope is deliberately
**additive** — no change rewires or destabilises the one working live signal/paper-trade
path, and no destructive DB operation is run. Items the remediation intentionally does
**not** attempt (with reasons) are listed at the end.

Baseline: commit `1c2941b`, branch `refactor/signals`, 208 files / 3280 tests pass.

---

## Changes

### [Phase 0] Baseline captured
- Added `reports/REMEDIATION_BASELINE.md` (frozen snapshot; preserves audit numbers).
- Added this changelog.
- No code changed.

### [Phase 3/4] Durable prediction/resolution persistence (additive)
- `prisma/schema.prisma`: added `IndiaPredictionRecord` + `IndiaResolutionRecord`
  models (full creation-time snapshot; unique `signalId` on both → immutable
  prediction + idempotent resolution; FK cascade). Additive only.
- `prisma/migrations/20260909000000_add_india_prediction_resolution_records/migration.sql`:
  generated (CREATE TABLE/INDEX only, no drops). NOT applied to the local DB
  (which has a pending migration not authored here); apply with `prisma migrate deploy`.
- `src/lib/india/prisma-signal-record-store.ts`: `PrismaSignalRecordStore implements
  SignalRecordStore` — durable adapter enforcing immutability (reject second
  prediction) + idempotency (reject second resolution) + unknown-signal guard.
- `tests/lib/india/prisma-signal-record-store.test.ts`: 5 tests (round-trip,
  immutability, idempotency, unknown-signal, list semantics) — all pass.
- `prisma validate` ✅, `prisma generate` ✅. NOT wired into the live worker yet
  (that is tracked remaining P0 work — see remediation report).

### [Phase 7] Model-state gate (additive)
- `src/lib/india/model-state-gate.ts`: explicit `UNTRAINED | SHADOW | VALIDATED |
  PRODUCTION` states; `classifyModelState` (uniform prior → UNTRAINED; trained-
  but-unproven → SHADOW; OOS-validated → VALIDATED); `evaluateAPlusEligibility`
  enforces that only VALIDATED/PRODUCTION may drive a live A+ — else ABSTAIN.
- `tests/lib/india/model-state-gate.test.ts`: 9 tests, all pass.

### [Phase 33] Promotion-gate state machine (additive)
- `src/lib/india/promotion-gates.ts`: 18 mandatory gates; `evaluatePromotion`
  returns HALTED on catastrophic (P0) gate failure, PRODUCTION_CANDIDATE only
  when ALL gates pass, else PAPER. Never returns PRODUCTION automatically.
- `tests/lib/india/promotion-gates.test.ts`: 6 tests, all pass; current real
  evidence yields PAPER (with catastrophic gates passing) and the empty default
  yields HALTED (safe posture: not-proven-safe = unsafe).

### [Phase 39] Automated regression guards (additive)
- `tests/lib/india/remediation-regression-guards.test.ts`: guards for
  no-A+-with-netEV≤0, untrained-can't-drive-A+, direct-NSE-stays-removed,
  no-duplicate-resolution + immutable-prediction, missing-data→NO_TRADE. All pass.

### [Verification]
- `npx tsc --noEmit` ✅ (0 errors)
- `npx eslint` on all new files ✅ (0 warnings)
- Full suite: **212 files / 3309 tests pass** (baseline was 208/3280; +4 files,
  +29 tests, 0 regressions).

### Intentionally NOT done in this pass (tracked remaining work)
- **Rewiring the live worker path** through the new engines (Phase 1/2/24/30):
  deferred. The new engines are additive; wiring `computeIndiaUniverse` /
  `openIndiaPaperTrade` / `resolveIndiaOpenTrades` is high-blast-radius and
  cannot be runtime-verified here (no live market/broker). Doing it blind would
  risk breaking the ONE working path to wire in models with no validated edge.
  Remains **P0**.
- **Historical replay / walk-forward** (Phase 26/27) and all **real
  monotonicity / calibration / segmented performance** tables (Phase 8/9/16/17/
  18/37): NOT MEASURABLE — no persisted multi-session data (RCA-001). Remains **P0/P1**.
- **Deploying the ML models** (Phase 10/13): correctly NOT done — 0/7 have OOS
  edge; DISABLED is the right state. Remains **P1**.
- Applying the new migration to a live DB: generated only (`prisma migrate
  deploy` in the target env); local DB has an unrelated pending migration.

## P0/P1 RUNTIME INTEGRATION PHASE (2026-09-09, additive, execution UNCHANGED)

### [Phase 1/3] Signal mode + canonical decision authority
- `src/lib/india/signal-mode.ts`: `SignalMode` (LEGACY/SHADOW/PAPER/PRODUCTION_CANDIDATE),
  default **SHADOW**; `resolveSignalMode` (env `INDIA_SIGNAL_MODE`, fail-safe to SHADOW);
  `newStackControlsExecution` (only PAPER/PRODUCTION_CANDIDATE).
- `src/lib/india/canonical-decision.ts`: strict veto ladder
  (CRITICAL_DATA→REJECT, INSUFFICIENT_DATA→ABSTAIN, RISK_BLOCKED→NO_TRADE,
  UNTRAINED_MODEL→WAIT, CALIBRATION_UNAVAILABLE→WAIT, NEGATIVE_NET_EV→NO_TRADE,
  FAILS_COST_STRESS→NO_TRADE, FRAGILE→WATCH, INSUFFICIENT_EVIDENCE→WATCH,
  A_PLUS/VALIDATED_HIGH_EDGE→TRADE). A lower BUY can never override a higher veto.
- `tests/lib/india/canonical-decision.test.ts`: 15 tests.

### [Phase 2/4/19/20/21] Shadow signal-intelligence evaluator
- `src/lib/india/shadow-intelligence.ts`: `evaluateShadow(candidate, artifact, cluster)`
  composes the REAL engines — meta artifact → `deriveMetaModelState` (model-state gate)
  → `runProfitabilityPipeline` (net EV, cost stress, counterfactual, derivatives gate)
  → `runAPlusFactory` (evidence gate, correlation dedup) → `resolveCanonicalDecision`.
  Untrained meta ⇒ contribution 0 + widened uncertainty + `mlAbstained` (no fabricated
  conviction). **This gives `runProfitabilityPipeline` and `runAPlusFactory` real
  runtime callers.**

### [Phase 5/6] Durable persistence wiring
- `src/lib/india/shadow-persistence.ts`: `persistShadowPrediction` (immutable) +
  `persistShadowResolution` (idempotent) via `PrismaSignalRecordStore`; conservative
  net-return (return − cost − slippage); AMBIGUOUS handled as conservative STOP_HIT +
  `ambiguous` flag (never favorable). Proven used (not merely imported).

### [Phase 27/28] Tests
- `tests/lib/india/shadow-intelligence.test.ts`: 11 e2e + persistence tests.
- `tests/lib/india/runtime-wiring-guards.test.ts`: static guards proving
  runProfitabilityPipeline / runAPlusFactory / PrismaSignalRecordStore / canonical
  decision / model-state gate have real (non-test) callers; NSE stays removed; SHADOW
  default.

### [Phase 8/11] Honest empirical status
- `reports/HISTORICAL_DATA_AVAILABILITY.md`: **HISTORICAL REPLAY BLOCKED — INSUFFICIENT
  DATA** (no multi-session intraday; option_chain_snapshot absent in DB).
- `reports/ML_FAILURE_ROOT_CAUSE.md`: per-model root cause; 0/7 beat baseline → DISABLE.

### [Verification]
- `tsc --noEmit` ✅ · `eslint` (new files) ✅ · `prisma validate` ✅
- Full suite: **215 files / 3342 tests pass** (was 212/3309; +3 files, +33 tests, 0 regressions).

### Honest remaining gap (self-audit Phase 37)
- `evaluateShadow` is composed + proven callable but is **not yet invoked by
  `computeIndiaUniverse` / the india-scalper worker**. The final hook into the live
  builder is the remaining P0 step; it was deferred to avoid destabilising the one
  working path without a runtime-verifiable environment. The integration layer + guards
  make that hook a small, safe, well-tested follow-up.
