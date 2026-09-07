# Phase 3D — India-Native Alpha Feature Engine: Quality Report

**Phase:** 3D — India-Native Alpha Feature Engine & Feature Governance
**Feature engine version:** `fv5`
**Config hash:** `c73806a856fa4e16`
**Date:** 2026-09-06
**Branch:** `refactor/improve-ml-service`

---

## Test Results

| Suite | Collected | Passed | Failed | Skipped |
|-------|-----------|--------|--------|---------|
| `test_phase3d.py` | 125 | **125** | **0** | 0 |
| `test_phase3c.py` | 63 | 61 | 0 | 2 (sklearn/talib) |
| `test_vpin.py` | 13 | 13 | 0 | 0 |
| **Overall** | **201** | **199** | **0** | **2** |

---

## Feature Inventory

| Metric | Count |
|--------|-------|
| Total registered | 115 |
| Active | 109 |
| Deprecated | 6 |
| Blocked | 0 |
| Requiring talib | 26 |
| DATA_UNAVAILABLE sources | 38 |
| Promotion: RESEARCH | 109 |
| Promotion: PRODUCTION_CANDIDATE | 0 |

**Note on promotion:** All 109 features are `RESEARCH` state. No feature is `PRODUCTION_CANDIDATE` because no OOS IC experiment has been run against real Indian equity data. This is the correct state for Phase 3D. Promotion requires Phase 3E OOS validation.

### By family

| Family | Count |
|--------|-------|
| Momentum | 13 |
| Trend | 10 |
| Mean Reversion | 7 |
| Volatility | 7 |
| Volume / Liquidity | 15 |
| Market Structure | 13 |
| Cross-Sectional | 3 |
| Breadth | 5 |
| Sector | 4 |
| Derivatives / F&O | 11 |
| Options / IV | 3 |
| Expiry / Contract | 5 |
| Market Regime | 8 |
| Intermarket | 1 |
| Microstructure | 1 |
| Time of Day | 1 |
| Overnight / Gap | 2 |

---

## Leakage Audit

**Verdict: PASS**

| Check | Result |
|-------|--------|
| Features with PITSafety.UNSAFE | 0 |
| Features with PITSafety.UNVERIFIED | 0 |
| INVALID shift(-N) in feature code | 0 |
| INVALID center=True in feature code | 0 |
| Mutation tests (13 total) | 13 PASS / 0 FAIL |
| fillna(0) INVALID occurrences | 0 |
| fillna(0) CAUSAL (economically defensible) | 1 |

### Mutation tests passed

| Test | Mutation | Result |
|------|----------|--------|
| return_20d | price | PASS |
| return_20d | volume | PASS |
| rsi_14 | price | PASS |
| rsi_14 | volume | PASS |
| realized_vol_20 | price | PASS |
| realized_vol_20 | volume | PASS |
| relative_volume | price | PASS |
| relative_volume | volume | PASS |
| trend_strength | price | PASS |
| trend_strength | volume | PASS |
| bos_net | price | PASS |
| bos_net | volume | PASS |
| cross_sectional_universe_mutation | universe | PASS |

### Static analysis findings

| Classification | Count |
|---------------|-------|
| CAUSAL | 1 |
| LABEL_ONLY | 3 |
| OUTCOME_ONLY | 3 |
| INVALID | **0** |
| UNCLASSIFIED | 10 |

The 10 UNCLASSIFIED findings are in test files and non-feature utility modules — none are in feature computation paths.

The 1 CAUSAL `fillna(0)` is the A/D line MF multiplier in `volume.py` — when HL range = 0 (doji bar), CLV is undefined and 0 is the neutral economically-defensible value.

---

## Silent-Default Bugs Fixed (20 total)

Phase 3D corrected 20 HIGH/CRITICAL silent-default substitutions where unknown data was being silently treated as a known neutral market state.

| ID | Severity | Feature | Old Behaviour | Fix |
|----|----------|---------|---------------|-----|
| FIX-3D-001 | **CRITICAL** | All features | Global NaN→0.0 sweep at end of `compute_stock_features()` | Only `inf` removed; NaN preserved as DATA_UNAVAILABLE |
| FIX-3D-002 | **HIGH** | `relative_strength_vs_nifty` | `1.0` when NIFTY absent | `NaN` |
| FIX-3D-003 | **HIGH** | `sector_momentum` | `0.0` when sector absent | `NaN` |
| FIX-3D-004 | **HIGH** | `sector_relative_strength` | `1.0` when sector absent | `NaN` |
| FIX-3D-005 | **HIGH** | `vix_level` | `15.0` when VIX absent | `None` |
| FIX-3D-006 | **HIGH** | `vix_regime` | `1.0` (moderate) when VIX absent | `None` |
| FIX-3D-007 | **HIGH** | `vix_percentile` | `50.0` when insufficient history | `None` |
| FIX-3D-008 | **HIGH** | `pct_above_sma20/50/200` | `50.0` when no stock data | `None` |
| FIX-3D-009 | **HIGH** | `pcr_oi` | `1.0` when no OI data | `None` |
| FIX-3D-010 | **HIGH** | Model feature vectors | `feats.get(f, 0.0)` for all 4 model feature lists | `feats.get(f, float('nan'))` |
| FIX-3D-011 | Medium | `atm_iv` | `0.0` when absent (impossible) | `None` |
| FIX-3D-012 | Medium | `delivery_pct` | `0.0` when absent (unknown ≠ 0%) | `NaN` |
| FIX-3D-013 | Medium | `pcr_score` | `0.0` when PCR None | `None` |
| FIX-3D-014 | Medium | `pcr_raw` | `1.0` when PCR None | `NaN` |
| FIX-3D-015 | Medium | `max_pain_distance_pct` | `0.0` when max_pain None | `None` |
| FIX-3D-016 | Medium | `days_to_weekly_expiry` | `5` when None | `None` |
| FIX-3D-017 | Medium | `days_to_monthly_expiry` | `20` when None | `None` |
| FIX-3D-018 | Medium | `sector_dispersion` | `0.0` when absent | `None` |
| FIX-3D-019 | Medium | `rotation_score` | `0.0` when absent | `None` |
| FIX-3D-020 | Medium | `trend_alignment` (RISK set) | `feats.get('trend_strength', 0.0)` | `feats.get('ema_stack_score', NaN)` + deprecated |

---

## Data Availability

### Sources available in test environment

- `equity_ohlcv` — all OHLCV-based features computable
- `nifty_ohlcv` — NIFTY regime features computable
- `banknifty_ohlcv` — BankNifty features computable

### Sources unavailable (DATA_UNAVAILABLE)

| Source | Features affected |
|--------|-------------------|
| NSE derivatives (PCR, OI) | `pcr_score`, `pcr_raw`, `oi_buildup_score`, `oi_delta_skew_norm` |
| NSE options (IV, max pain, OI walls) | `iv_rank`, `atm_iv`, `max_pain_distance_pct`, `ce/pe_wall_distance_pct` |
| NSE bhavcopy (delivery, A/D) | `delivery_pct`, `advance_decline_ratio` |
| NSE expiry calendar | `days_to_weekly_expiry`, `days_to_monthly_expiry`, `is_expiry_day` |
| India VIX series | `india_vix`, `vix_regime`, `vix_percentile`, `vix_mean_reversion` |
| Intermarket data | `global_sentiment`, `us_futures_change`, `crude_change` |
| Sector master (PIT) | `sector_momentum`, `sector_relative_strength`, `sector_dispersion` |
| Historical universe (PIT) | `cs_return_20d_rank`, `cs_return_5d_rank`, `cs_rs_nifty_rank`, breadth features |
| Intraday OHLCV | `vpin_score` |

All 38 features with unavailable sources correctly return `NaN` / `None` with `DATA_UNAVAILABLE` status. **No fabrication.**

---

## Phase 3D Acceptance Criteria

| Category | Criterion | Status |
|----------|-----------|--------|
| Architecture | Canonical feature registry | ✅ `registry.py` — 115 features |
| Architecture | Feature family taxonomy | ✅ 17 families in `FeatureFamily` enum |
| Architecture | Feature versioning | ✅ `feature_version` on every `FeatureSpec` |
| Architecture | Feature provenance | ✅ `source`, `formula_id`, `lookback`, `label_config_hash` |
| Architecture | Explicit model feature sets | ✅ `RANKING_FEATURE_SET`, `REGIME_FEATURE_SET`, `STRATEGY_FEATURE_SET`, `RISK_FEATURE_SET` |
| Causality | No future rolling windows | ✅ All families use trailing windows only |
| Causality | No future normalization | ✅ CS rank is timestamp-local |
| Causality | No future universe | ✅ Caller passes `historical_universe(t)` |
| Causality | No future sector membership | ✅ Sector features parameterised by caller |
| Causality | No future OI/options | ✅ All derivatives features DATA_UNAVAILABLE offline |
| Causality | No future-confirmed market structure | ✅ BOS/CHOCH trailing-only; FVG 3-bar causal |
| Missing data | No meaningless NaN→0 | ✅ 20 silent defaults fixed |
| Missing data | Unavailable data explicit | ✅ `AvailabilityStatus.DATA_UNAVAILABLE` |
| Missing data | No fabricated historical observations | ✅ Verified by all None/NaN tests |
| Cross-sectional | Historical universe used | ✅ (caller responsibility, tests verify) |
| Cross-sectional | Timestamp-local ranking | ✅ `cross_sectional_rank` is per-call |
| Cross-sectional | Mutation tests pass | ✅ 13/13 PASS |
| India-native | Breadth implemented | ✅ `pct_above_sma20/50/200` |
| India-native | Sectors implemented | ✅ `sector_momentum`, `sector_relative_strength` |
| India-native | F&O implemented (DATA_UNAVAILABLE offline) | ✅ |
| India-native | Expiry implemented | ✅ |
| India-native | OI features | ✅ |
| India-native | IV features | ✅ |
| India-native | India market calendar | ✅ NSE 09:15–15:30 in `compute_time_features` |
| Quality | Feature quality gate | ✅ `run_quality_gate()` |
| Quality | Redundancy diagnostics | ✅ Pearson union-find groups |
| Quality | Stability diagnostics | ✅ missing/std/outlier per feature |
| Quality | Leakage report | ✅ `FeatureLeakageReport` with verdict |
| Testing | Deterministic tests | ✅ 125 tests |
| Testing | PIT mutation tests | ✅ 12 price/volume mutations |
| Testing | CS mutation tests | ✅ 1 universe determinism test |
| Testing | Structure causality tests | ✅ FVG/BOS future-data tests |
| Testing | Missing-data tests | ✅ All 20 silent-default bugs tested |

---

## Known Limitations

1. **No real dataset** — All quality metrics from synthetic data only. Real-data quality analysis deferred to Phase 3E.
2. **RESEARCH state only** — No feature is `PRODUCTION_CANDIDATE`. Promotion requires OOS IC evidence.
3. **talib absent** — 26 features use talib in production; tested via talib-free reference implementations.
4. **F&O data offline** — 38 features cannot be exercised without live NSE data.
5. **OOS IC not computed** — Deferred to Phase 3E.
6. **Sector membership PIT** — Depends on Phase 3B `sector_master`; offline returns NaN.
