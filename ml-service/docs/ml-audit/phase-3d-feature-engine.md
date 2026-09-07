# ML Audit: Phase 3D — India-Native Alpha Feature Engine

**Phase:** 3D — India-Native Alpha Feature Engine & Feature Governance
**Audit scope:** All feature modules, governance infrastructure, silent-default fixes, leakage certification
**Feature engine version:** `fv5`
**Branch:** `refactor/improve-ml-service`
**Date:** 2026-09-06
**Status:** PASS — 125/125 tests pass; leakage audit PASS; 0 INVALID features

---

## 1. What Changed and Why

### 1.1 Problems with the pre-Phase-3D feature layer

Phase 3D began with a forensic audit of every feature in the existing `src/features/` package. The audit found:

**CRITICAL:**
- `engineer.py` applied a global `NaN → 0.0` sweep at the end of `compute_stock_features()` and `compute_regime_features()`. This silently converted every unavailable feature value to 0.0, conflating *unknown* with *neutral*. For example, missing VIX became `vix_level = 0`, missing PCR became `pcr_score = 0`, missing breadth became `pct_above_sma20 = 0`.

**HIGH (9 features):**
- `relative_strength_vs_nifty = 1.0` when NIFTY data absent (1.0 is a real RS level)
- `sector_momentum = 0.0` when sector data absent (0% return is a real market state)
- `sector_relative_strength = 1.0` when sector absent
- `vix_level = 15.0`, `vix_regime = 1.0`, `vix_percentile = 50.0` when VIX absent
- `pct_above_sma20/50/200 = 50.0` when no stock universe
- `pcr_oi = 1.0` when no OI data
- `feats.get(f, 0.0)` for all 4 model feature vectors (missing feature → 0)

**MEDIUM (10 features):**
- `atm_iv = 0.0` when absent (0% IV is impossible)
- `delivery_pct = 0.0` (unknown delivery ≠ 0% delivery)
- `pcr_score = 0.0`, `pcr_raw = 1.0` for None PCR
- `days_to_weekly/monthly_expiry = 5/20` for None
- `sector_dispersion = 0.0`, `rotation_score = 0.0` for None

**Governance:**
- No feature registry, schemas, versioning, or PIT-safety flags
- No formal family taxonomy
- No availability status on any feature output
- No leakage validator

### 1.2 What Phase 3D delivers

1. **Feature governance infrastructure** — `schemas.py`, `config.py`, `registry.py`, `quality.py`, `availability.py`
2. **Feature family implementations** — 6 talib-free modules in `families/` covering all economically meaningful families
3. **20 silent-default bug fixes** — every identified HIGH/CRITICAL default is corrected
4. **Leakage validator** — static + mutation + cross-sectional tests
5. **115-feature registry** — every feature registered with source, formula, lookback, PIT safety, missing policy

---

## 2. New File Inventory

```
ml-service/src/features/
├── schemas.py           # FeatureSpec, FeatureValue, FeatureRow, FeatureSetSpec,
│                        # LeakageCertification; FeatureFamily, AvailabilityStatus,
│                        # PITSafety, FeaturePromotion, MissingPolicy, NormalizationPolicy
├── config.py            # 12 sub-configs (MomentumConfig, VolatilityConfig, ...),
│                        # FeatureEngineConfig (deterministic hash)
├── registry.py          # 115-feature FEATURE_REGISTRY; 4 FeatureSetSpecs
├── quality.py           # run_quality_gate(): 10 checks incl. redundancy
├── availability.py      # FeatureAvailabilityChecker (PIT enforcement),
│                        # MissingDataGuard, make_feature_value_from_series
├── leakage_validator.py # run_static_leakage_audit(), audit_fillna_zero(),
│                        # run_mutation_test(), run_full_leakage_audit()
└── families/
    ├── __init__.py
    ├── momentum.py       # 20 functions; talib-free reference implementations
    ├── volatility.py     # realized_vol, Parkinson, vol_regime, vol_percentile
    ├── volume_liquidity.py # VWAP (corrected rolling mode), Amihud, OBV zscore
    ├── market_structure.py # FVG (vectorised), OB, BOS/CHOCH (trailing-only), sweeps
    ├── cross_sectional.py  # rank, zscore, breadth, sector (all None for absent data)
    └── derivatives.py     # PCR, IV rank, OI buildup, expiry, VIX (all None for absent)
```

**Modified files:**
- `features/derivatives.py` — `compute_pcr_score`, `compute_max_pain_distance`, `compute_options_flow_features` return `None` not `0.0`/`1.0`
- `features/macro.py` — `compute_vix_features`, `compute_market_breadth`, `compute_expiry_features` return `None` not fabricated values
- `features/engineer.py` — silent defaults removed; `_last_or_nan()` added; `_last_or_nan` used for MUST_NOT_FABRICATE features
- `training/data_pipeline.py` — all `feats.get(f, 0.0)` → `feats.get(f, float('nan'))`

---

## 3. Leakage Certification

| Criterion | Result |
|-----------|--------|
| shift(-N) in feature code | **NONE** |
| center=True in feature code | **NONE** |
| INVALID static findings | **0** |
| Mutation tests (13) | **13 PASS** |
| fillna(0) INVALID | **0** |
| Features PITSafety.UNSAFE | **0** |
| Features PITSafety.UNVERIFIED | **0** |

The 3 LABEL_ONLY static findings are in `data_pipeline.py` — forward-shift used for label target computation, not feature engineering.

The 1 CAUSAL `fillna(0)` in `volume.py` is the A/D line MF multiplier for doji bars — economically defensible.

---

## 4. Silent-Default Bugs Fixed

All 20 HIGH/CRITICAL bugs identified in the audit are fixed and tested. See `reports/phase-3d-feature-quality.md` for the full table.

**The key invariant:** `unknown != neutral`. Missing data must always be `NaN` / `None` with an explicit `AvailabilityStatus`. The model preprocessing layer may impute later, with explicit documentation.

---

## 5. Feature Registry Structure

Every feature in `FEATURE_REGISTRY` has a `FeatureSpec` declaring:

```python
FeatureSpec(
    feature_name="return_20d",
    feature_version="momentum-v1",
    family=FeatureFamily.MOMENTUM,
    source="equity_ohlcv",
    formula_id="pct_change_20",
    required_columns=["close"],
    lookback=21,
    causal=True,
    pit_safety=PITSafety.SAFE,
    cross_sectional=False,
    missing_policy=MissingPolicy.RETURN_NAN,
    normalization_policy=NormalizationPolicy.PERCENT,
    promotion=FeaturePromotion.RESEARCH,
    economic_rationale="...",
)
```

Versioning rule: changing formula, lookback, source, normalization, or missing-data semantics requires a new `feature_version`. Old versions must be `DEPRECATED`, never silently overwritten.

---

## 6. Model Feature Sets

Models no longer consume uncontrolled global lists. Four explicit `FeatureSetSpec` objects declare which features each model uses:

```python
RANKING_FEATURE_SET  = FeatureSetSpec(set_id="RANKING_SET",  set_version="v1", feature_names=[...], ...)
REGIME_FEATURE_SET   = FeatureSetSpec(set_id="REGIME_SET",   set_version="v1", feature_names=[...], ...)
STRATEGY_FEATURE_SET = FeatureSetSpec(set_id="STRATEGY_SET", set_version="v1", feature_names=[...], ...)
RISK_FEATURE_SET     = FeatureSetSpec(set_id="RISK_SET",     set_version="v1", feature_names=[...], ...)
```

All 64 + 27 + 17 + 15 declared feature names are verified to exist in `FEATURE_REGISTRY`.

---

## 7. Deprecated Features Documented

Six features are formally deprecated in the registry:

| Feature | Reason | Replacement |
|---------|--------|-------------|
| `market_breadth_score` | Ambiguous name, silent 50.0 default | `pct_above_sma20` |
| `volatility_rank` | No implementation in engineer.py; silently became 0 | `vol_regime` |
| `trend_alignment` | No implementation in RISK set; silently became 0 | `ema_stack_score` |
| `stop_distance_atr` | Trade-specific; silently became 0 | `atr_pct` |
| `target_distance_atr` | Trade-specific; silently became 0 | `atr_pct` |
| `risk_reward_ratio` | Trade-specific; silently became 0 | `atr_pct` |

---

## 8. Backward Compatibility

| Consumer | Status |
|----------|--------|
| `train_all.py` | Unaffected — pipeline API unchanged |
| `compute_stock_features()` | API unchanged; now returns NaN instead of 0 for unavailable features. Models must handle NaN (already filtered by `valid_mask = ~np.any(np.isnan(X), axis=1)` in build functions) |
| `compute_regime_features()` | Same |
| `RANKING_FEATURES` list | Preserved in registry as `RANKING_FEATURE_SET.feature_names` |
| `test_vpin.py` (13 tests) | All pass |
| `test_phase3c.py` (63 tests) | 61 pass / 2 skip (pre-existing) |

---

## 9. Phase 3E Gaps

These items are explicitly deferred:

1. **OOS IC / Rank IC experiment** — requires real Indian equity historical data loaded through the Phase 3B pipeline
2. **Feature promotion from RESEARCH → VALIDATED** — requires OOS stability evidence
3. **ATR barrier calibration per symbol** — Phase 3D does not touch labels; deferred
4. **Sector PIT membership database** — Phase 3B sector_master not yet populated
5. **talib-backed features in test environment** — requires TA-Lib installation
6. **Feature selection / redundancy reduction** — diagnostics are produced; selection is Phase 3E
7. **Real-data quality statistics** — missingness, distribution, redundancy groups on actual Indian equity data
