# ALPHAFORGE RUNTIME INTEGRATION REPORT

**Date:** 2026-09-09. Additive, execution UNCHANGED. Full suite 215/3342 green.

## What is now wired (proven by tests + self-audit grep)

| Component | Runtime caller | Status |
|---|---|---|
| `runProfitabilityPipeline` | `shadow-intelligence.evaluateShadow` | ✅ real caller |
| `runAPlusFactory` | `shadow-intelligence.evaluateShadow` | ✅ real caller |
| `PrismaSignalRecordStore` | `shadow-persistence` | ✅ real caller |
| `resolveCanonicalDecision` | `shadow-intelligence.evaluateShadow` | ✅ real caller |
| model-state gate (`classifyModelState`) | `shadow-intelligence.deriveMetaModelState` | ✅ real caller |

The new stack is composed into ONE canonical pipeline (`evaluateShadow`): meta artifact
→ model-state gate → profitability (net EV / cost stress / counterfactual / grade) →
A+ factory (evidence gate / correlation dedup) → canonical decision authority. Mode is
**SHADOW by default** (`signal-mode.ts`) so the new stack computes + persists but does
**not** alter execution — the working legacy signal→paper-trade path is untouched.

## Canonical decision authority

`canonical-decision.ts` enforces a strict veto ladder; a lower-level BUY can never
override a higher veto (critical data, risk, negative EV, untrained model, cost
stress, fragility). Tested (15 cases), including "higher veto always wins".

## Honest gap (self-audit Phase 37)

`evaluateShadow` is **not yet invoked by `computeIndiaUniverse` / the india-scalper
worker**. The integration layer exists, is composed correctly, has real callers, and
is fully tested — but the final one-line hook into the live builder is the remaining
**P0** step. It was deferred deliberately: wiring it blind (no live market/broker/DB to
verify against) would risk the one working path, and the models it would feed have no
validated edge yet. With the layer + guards in place, that hook is now a small, safe,
test-covered follow-up.

## Verdict

Runtime integration: **substantially advanced** — the previously-dark engines now have
real callers and a single canonical decision — but **not yet fully live** (builder hook
pending). Correctly remains SHADOW.
