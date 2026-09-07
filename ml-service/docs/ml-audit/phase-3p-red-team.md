# Phase 3P — Independent Quant Validation & Red-Team Methodology

**Branch:** `refactor/improve-ml-service` · **HEAD:** `ff31a69`
**Final status:** `PHASE_3P_PASS` · **Evidence state:** `PAPER_VALIDATED_WITH_LIMITATIONS`
**Live trading:** DISABLED · **Live order path:** UNREACHABLE · not `LIVE_READY`

---

## 1. Mindset

Phase 3P is an adversarial validation phase. The working assumption is: *the
reported edge is wrong until the system survives adversarial validation.* The
question is not "can we find profitable results?" but "can we find a credible
reason the reported results are invalid?" Valid outcomes include
`EVIDENCE_REJECTED`, `EVIDENCE_UNVERIFIABLE`, and `INSUFFICIENT_EVIDENCE`. Nothing
is trusted from comments, docstrings, phase names, test names, README claims, or
generated reports — every material claim is verified from code + executable tests.

## 2. Independent validation

Where practical, production results were recomputed by an INDEPENDENT
implementation and required to agree:

- **Artifact hashing** — `compute_artifact_hash` vs a fresh `hashlib.sha256` over
  the same bytes (file and directory). Agreement confirmed; any tamper flips the
  hash and fails closed.
- **Sharpe / Brier** — annualized Sharpe and Brier recomputed from raw series and
  matched to `paper.evidence` within 1e-6.
- **Expected value** — `EV = P·win − (1−P)·|loss| − cost` recomputed and matched.
- **Execution shortfall** — VWAP-vs-arrival recomputed and matched.

## 3. Red-team methodology

Adversarial attacks were run against every safety-critical surface and required to
FAIL CLOSED. See `reports/phase-3p/phase_3p_red_team_report.json` for the full
matrix. Highlights:

- **PIT / leakage:** future-stamped inputs at T+1s…T+1w, future universe membership,
  future F&O lot size → CRITICAL `LOOKAHEAD_LEAK`; missing availability → fail closed.
- **Lifecycle:** unregistered / ineligible / contaminated-OOS / incompatible
  challengers → promotion BLOCKED; concurrent promotions → exactly one champion.
- **Accounting / execution:** wrong closing equity → `UNEXPLAINED_MISMATCH`;
  duplicate events applied once; all-unusable providers → `NO_NEW_DECISIONS`.
- **Statistics:** small samples → INSUFFICIENT; multiple hypotheses corrected by
  Bonferroni/BH; random-label negative control → ~zero IC.

## 4. Evidence levels

`E0` none · `E1` synthetic/unit · `E2` historical replay · `E3` purged OOS ·
`E4` paper/shadow · `E5` independently reproduced. Levels are **not** upgraded
merely because more tests exist. The independent evidence ledger
(`src/validation/evidence_audit/`) refuses to record an internally inconsistent
claim, never auto-grants E5 without an independent reproduction, and only counts
SUPPORTED, well-formed claims toward the corpus level.

In this environment no real market data / model artifacts are reachable, so all
economic and predictive results are `REPRODUCTION_INCOMPLETE` and capped at **E1**.
The safety/correctness *machinery* is E1 (unit-verified + independently confirmed).

## 5. Negative controls & mutation testing

- **Negative control:** cross-sectional IC on random labels stays near zero — a
  strong control result would have signalled `LEAKAGE_OR_EVALUATION_DEFECT`.
- **Mutation testing (test-the-tests):** planted defects (a future-stamped input;
  a wrong closing equity) are DETECTED by the suite — a green suite that cannot
  catch a known defect is not evidence.

## 6. Statistical audit

Metric implementations were independently recomputed; small-sample and constant
inputs return UNAVAILABLE / INSUFFICIENT_EVIDENCE rather than misleading numbers;
multiple-testing correction was verified to remove marginal significance as the
hypothesis count grows.

## 7. Security audit

- No secret literals (AWS keys, private-key blocks, assigned api_secret/access_token/
  refresh_token/password) in `ml-service/src`.
- No broker order-placement primitives (`place_order`/`submit_order`/`modify_order`/
  `cancel_order`/`SmartConnect`/…) in `ml-service/src` — live order path is
  UNREACHABLE from the ML service.
- No `NEXT_PUBLIC_*` secret-like variables in the frontend (nothing leaks to the
  client bundle). The scans report file+pattern only and NEVER a matched value.

## 8. Promotion audit + defects found and fixed

Two HIGH promotion-integrity defects were found by independent probes and FIXED
(spec §79: fix the defect, do not tune away evidence). Both now have regression
tests in `tests/test_phase3p.py`:

- **P3P-001 (HIGH):** compatibility was not enforced in `promote()` — an
  incompatible challenger could become champion. Fixed by wiring the existing
  `CompatibilityChecker` (feature + label version) into the promotion path.
- **P3P-002 (HIGH):** `_atomic_promote` flipped the champion pointer before
  advancing the registry, allowing a divergent champion/registry state that
  recovery mis-classified as committed. Fixed by validating eligibility up front so
  an ineligible challenger causes zero state change.

Because both HIGH findings were fixed and regression-tested (no CRITICAL findings,
no unresolved HIGH findings in PIT / execution / accounting / registry / promotion /
security / provenance / statistical categories), certification is not blocked.

## 9. Limitations

- Economic/predictive edge is **neither confirmed nor disproven** here — it is
  `INSUFFICIENT_EVIDENCE` because no real market data is reachable.
- DL (torch) and sklearn-dependent paths are not executable in this environment;
  their leakage guards rest on design + prior-phase tests, not re-execution.
- Coverage is assessed qualitatively (critical-path invariant table below), as
  `pytest-cov` is not available.

## 10. Critical-path invariant coverage

| Component | Critical invariant | Executable test |
|---|---|---|
| Lifecycle registry | immutable artifact identity; invalid transition rejected | test_model_registry_red_team |
| Promotion | fail-closed on unregistered/ineligible/contaminated/incompatible | test_promotion_fail_closed |
| Promotion atomicity | no divergent champion/registry state | test_promotion_fail_closed / test_concurrent_promotion |
| Rollback | restores exact prior champion identity | test_rollback_atomicity |
| Artifact integrity | tamper → INTEGRITY_FAILURE | test_artifact_tampering |
| PIT | future info → LOOKAHEAD_LEAK | test_future_data_attack / universe / fno |
| Probability semantics | no clip(raw_score,0,1) as probability | test_probability_semantics |
| EV | EV identity holds | test_ev_independent_calculation |
| Cost | net monotone in cost | test_cost_sensitivity |
| Accounting | equity identity; mismatch → blocked | test_paper_accounting_reconciliation |
| Idempotency | duplicate event once | test_duplicate_event_attack |
| Determinism | replay identical | test_replay_determinism |
| Provider failover | never CORRUPTED | test_provider_failover |
| Statistics | small-sample INSUFFICIENT; multiple-testing corrected | test_small_sample_metrics / test_multiple_testing |
| Negative control | random labels → ~0 IC | test_negative_controls |
| RL | execution-only, no gross PnL | test_rl_reward_hacking / test_rl_baseline_comparison |
| Security | no secrets; live path unreachable | test_secret_scan / test_live_order_path_unreachable |

## 11. Hard stop

After Phase 3P: STOP. No live trading, no order placement, no model promotion,
no retraining, no recalibration, no new alpha features, no threshold optimization,
no tuning against red-team findings, no Phase 3Q. Await the next instruction.
