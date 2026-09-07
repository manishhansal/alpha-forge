# Phase 3L — Robustness Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Perturbations (spec §61, §62)

A promising policy is evaluated under modest, realistic execution-assumption
perturbations. `DEFAULT_PERTURBATIONS`:

| Name | Change |
|------|--------|
| base | unchanged reference |
| worse_slippage | slippage × 2 |
| higher_spread | spread × 1.5 |
| higher_impact | +5 bps impact |
| lower_liquidity | ADV × 0.5 |
| execution_delay | +1 bar latency |

## 2. Simulator-Dependency Test (spec §60)

`robustness_report` flags **SIMULATOR_DEPENDENCY_RISK** when a policy's
performance collapses under these modest perturbations (degradation ≥ 80% or a
flip from positive to negative). A policy that only "works" under one exact set
of simulator assumptions is not trustworthy.

Verified by test:
- A robust policy (≈12% degradation across perturbations) → **no** risk flag.
- A fragile policy (base +100 → worse_slippage −20) → **SIMULATOR_DEPENDENCY_RISK**.

## 3. Failure Modes (spec §58, §59)

`detect_failure_modes` surfaces:
- policy collapse (one action ≥ 95% of steps)
- always-WAIT / always-AGGRESSIVE collapse
- excessive turnover (above cap)
- inventory accumulation (final ≠ target and larger than target)
- reward hacking (high trade frequency with ~zero net reward)
- action entropy (normalized) as a health signal

All detectors verified on synthetic policies.

## 4. Adversarial Market Conditions (spec §63)

The perturbation framework covers gap/volatility/liquidity-collapse style stress
via `lower_liquidity`, `higher_spread`, `higher_impact`, and `worse_slippage`.
Historical adversarial-condition evaluation requires real data → deferred as
INSUFFICIENT_EVIDENCE.

## 5. Current Result

No real RL policy has been trained on real data, so there is no production
robustness curve. The robustness and failure-mode apparatus is complete and
verified on synthetic policies. Any future promising policy MUST clear these
checks; a policy exhibiting SIMULATOR_DEPENDENCY_RISK is classified
`SIMULATOR_DEPENDENT` and cannot be promoted.

---

## 6. Verdict

Robustness framework complete and verified. **INSUFFICIENT_EVIDENCE** for a
production robustness claim (no real dataset / no valued policy).
