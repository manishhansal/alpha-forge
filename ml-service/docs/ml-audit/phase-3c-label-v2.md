# ML Audit: Phase 3C — Label V2

**Phase:** 3C — Label V2 & Event-Based Target Engineering
**Audit scope:** All new label modules, pipeline integration, backward compatibility
**Label version:** `lv2`
**Branch:** `refactor/improve-ml-service`
**Date:** 2026-09-06
**Status:** PASS — 61/63 tests pass; 2 skipped (sklearn/talib absent in env)

---

## 1. What Changed and Why

### 1.1 Problem with lv1 labels

AlphaForge's original (`lv1`) label functions had six documented defects:

| # | Defect | Location | Severity |
|---|--------|----------|----------|
| 1 | Simultaneous stop+target not resolved: `.any()` scan returns True for both independently, with no first-touch ordering | `data_pipeline.generate_risk_labels()` | Critical |
| 2 | No event timestamps — labels are bare floats with no provenance | All lv1 functions | High |
| 3 | No cost deduction — raw return labels overstate trader outcome | `generate_risk_labels()` | High |
| 4 | Incomplete horizon at tail classified as `TIME_LIMIT` (incorrect) or as `NaN` (correct but untagged) | Multiple | Medium |
| 5 | No sample uniqueness metadata — PurgedKFold uses fixed-horizon `t1`, not event-aware `t1` | `validation/purged_kfold.py` | Medium |
| 6 | No intrabar ambiguity handling — when both barriers appear in the same OHLC bar, outcome is undefined | `generate_risk_labels()` | Medium |

### 1.2 What lv2 delivers

lv2 replaces each defect with a principled fix:

1. **Sequential bar scan** — `triple_barrier.py` scans forward bar-by-bar. First barrier touched ends the scan. This makes first-touch semantically correct.
2. **`LabelEvent` base class** — every label now carries `event_start_time`, `event_end_time`, `label_available_time`, `label_config_hash`, `label_version`, `symbol`.
3. **`cost_model` in `LabelConfig`** — `DATA_UNAVAILABLE` by default. Net return computed only when a real cost model is populated.
4. **`is_incomplete=True` → `DATA_INSUFFICIENT`** — tail events where `t + horizon >= n` are tagged and excluded from supervised training. They are never reclassified as `TIME_LIMIT`.
5. **`build_t1_from_events()`** — event-aware `t1` Series aligned to `DatetimeIndex`, replacing fixed-horizon approximation.
6. **`ambiguity_policy`** — `CONSERVATIVE_SL` (default) or `DATA_AMBIGUOUS` for intrabar ambiguity. `intrabar_ambiguous=True` is always recorded in metadata.

---

## 2. Module Inventory

```
ml-service/src/labels/
├── __init__.py              # public surface: re-exports key classes
├── config.py                # LabelConfig (versioned, hashed), CostModelConfig
├── schemas.py               # dataclasses: LabelEvent, TripleBarrierLabel,
│                            #   FixedHorizonLabel, RiskOutcomeLabel, MetaLabel,
│                            #   SampleMetadata, LabelDiagnostics
│                            # enums: FirstTouch, Side, DirectionClass,
│                            #   PriceBasis, LabelFamily
├── validators.py            # LabelLeakageValidator — 7 rules, PIT check
├── registry.py              # LABEL_REGISTRY dict, active/deprecated, hash lookup
├── triple_barrier.py        # core event-based label engine
├── fixed_horizon.py         # raw/vol-adj/directional forward-return labels
├── meta_label.py            # TAKE/SKIP second-layer label
├── risk_outcomes.py         # MFE, MAE, holding period
├── sample_weights.py        # concurrency, average_uniqueness, build_t1
└── relative.py              # excess-vs-benchmark, sector-relative
```

---

## 3. Critical Invariants (what the tests enforce)

These invariants are not negotiable. Any code change that breaks them must be caught by CI.

### 3.1 Triple-barrier

| Invariant | Test |
|-----------|------|
| `is_incomplete=True` → `first_touch == DATA_INSUFFICIENT` (never `TIME_LIMIT`) | `TestIncompleteHorizon::test_tail_bars_not_time_limit` |
| `event_end_time >= event_start_time` always | `TestTripleBarrierGoldenTP::test_event_end_time_at_or_after_start` |
| `event_end_time <= contract_expiry` when expiry given | `TestExpiryAware::test_event_does_not_extend_past_expiry` |
| TP hit before SL in rising market (golden TP path) | `TestTripleBarrierGoldenTP::test_first_event_is_tp` |
| SL hit before TP in falling market (golden SL path) | `TestTripleBarrierGoldenSL::test_first_event_is_sl` |
| Time barrier fires when neither barrier reached | `TestTripleBarrierGoldenTimeLimit::test_first_event_is_time_limit` |
| Ambiguous bar never silently becomes TAKE_PROFIT | `TestIntrabarAmbiguity::test_ambiguous_never_silently_tp` |
| `CONSERVATIVE_SL` policy → ambiguous bar becomes STOP_LOSS | `TestIntrabarAmbiguity::test_conservative_sl_policy` |
| `DATA_AMBIGUOUS` policy → ambiguous bar becomes INTRABAR_AMBIGUOUS | `TestIntrabarAmbiguity::test_data_ambiguous_policy` |
| Long SL → gross_return < 0 | `TestTripleBarrierGoldenSL::test_gross_return_negative_for_long_sl` |
| Short SL → gross_return < 0 | `TestTripleBarrierLongShort::test_short_gross_return_sign` |
| Zero-price entries skipped | `TestTripleBarrierEdgeCases::test_zero_price_skipped` |
| Naive (no-tz) index raises `ValueError` | `TestTripleBarrierEdgeCases::test_naive_index_raises` |

### 3.2 Point-in-time (PIT) mutation

| Invariant | Test |
|-----------|------|
| Appending a future bar does not change `first_touch` of completed TB events | `TestPITMutationLabels::test_future_price_does_not_alter_historical_tb_label` |
| Appending a future bar does not change `gross_return` of completed FH events | `TestPITMutationLabels::test_future_price_does_not_alter_historical_fh_label` |

Note: events that were `is_incomplete=True` before the append are legitimately allowed to change — they become complete once the missing forward window is available. This is correct behaviour, not a PIT leak.

### 3.3 Validator rules

| Invariant | Test |
|-----------|------|
| Outcome column in feature list → CRITICAL violation | `TestValidators::test_rule1_outcome_col_in_features_is_critical` |
| Clean feature list → no violations | `TestValidators::test_rule1_clean_features_pass` |
| `is_incomplete=True` with `first_touch=TIME_LIMIT` → ERROR | `TestValidators::test_rule7_incomplete_as_time_limit_is_error` |
| `event_end_time < event_start_time` → CRITICAL | `TestValidators::test_tb_invariant_end_before_start_critical` |

### 3.4 Sample weights / PurgedKFold contract

| Invariant | Test |
|-----------|------|
| Non-overlapping events have `average_uniqueness == 1.0` | `TestSampleWeights::test_non_overlapping_events_have_full_uniqueness` |
| `build_t1_from_events()` aligns event end-times to the correct index position | `TestSampleWeights::test_build_t1_from_events_matches_end_times` |
| Uniqueness in `[0.0, 1.0]` | `TestSampleWeights::test_uniqueness_between_0_and_1` |

---

## 4. Bugs Found and Fixed

See `reports/phase-3c-label-integrity.md` for full details. Summary:

| ID | Severity | Description |
|----|----------|-------------|
| BUG-3C-001 | Critical | `_compute_atr_at_bar` returned `close * 0.01` (absolute) instead of `0.01` (fractional) — barriers 100× too wide on first bar |
| BUG-3C-002 | High | `contract_expiry` not applied to `is_incomplete` early-exit path; entries at/after expiry still generated |
| BUG-3C-003 | High | `pd.Timestamp(tz_aware_dt, tz="UTC")` fails in pandas ≥ 2.x — 8 tests broken |

All three bugs were introduced during initial implementation and caught by the Phase 3C test suite. There are no known regressions in previously-passing tests.

---

## 5. Backward Compatibility Audit

### 5.1 `train_all.py` consumers

`train_all.py` uses `y_stop`, `y_target`, `y_drawdown` from `generate_risk_labels()`. The lv2 implementation:
- Still returns `(y_stop, y_target, y_mae)` as `pd.Series` with the same index.
- `y_stop` = 1 when `STOP_LOSS`, 0 otherwise.
- `y_target` = 1 when `TAKE_PROFIT`, 0 otherwise.
- `y_mae` = worst adverse excursion (absolute % of entry) during event window.

**No changes required in `train_all.py`.** The tuple API is unchanged.

### 5.2 `generate_ranking_labels_v2()`

Returns `pd.Series` via `generate_ranking_labels_v2_compat()` in `relative.py`. Tested.

### 5.3 `DatasetSnapshot`

Fourteen new fields added. All are optional (`None` by default). No existing fields were removed or renamed. All existing callers that create `DatasetSnapshot` with keyword arguments continue to work.

### 5.4 lv1 functions in `models/`

`generate_regime_labels()` (market_regime.py), `generate_ranking_labels()` (stock_ranker.py), `generate_strategy_labels()` (strategy_selector.py) — none were modified. They remain lv1.

---

## 6. Static Analysis Results

**Command:** `grep -rn "shift(-" src/labels/ src/training/ --include="*.py"`

Four occurrences found. All classified `LABEL_ONLY`. None are feature-engineering paths. See `reports/phase-3c-label-integrity.md §Static Analysis` for the full table.

**Leakage verdict: CLEAN.**

---

## 7. Known Gaps for Phase 3D

The following are out of scope for Phase 3C and deferred:

1. **Per-symbol ATR calibration** — `pt_multiplier`/`sl_multiplier` are global defaults. Indian midcap stocks and Bank Nifty may need different multipliers.
2. **Cost model population** — `CostModelConfig` structure is ready but populated from `DATA_UNAVAILABLE`. Broker API round-trip costs (SEBI STT, brokerage, exchange charges) need to be loaded.
3. **Tick-level ambiguity resolution** — intrabar ambiguity below daily OHLC requires Level 2 or tick data. Not available.
4. **lv1 models migration** — `market_regime.py`, `stock_ranker.py`, `strategy_selector.py` still use lv1 labels. Migrating them to lv2 is Phase 3D work.
5. **PurgedKFold embargo tuning** — `embargo_pct` parameter not calibrated; requires real event overlap data.
6. **Observed label distribution** — TP%/SL%/TIME% on real Indian equity data not yet measured. `INSUFFICIENT_EVIDENCE` applies until real data is processed.
