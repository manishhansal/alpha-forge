# Phase 3C — Label V2 & Event-Based Target Engineering: Integrity Report

**Label Version:** `lv2`
**Date:** 2026-09-06
**Branch:** `refactor/improve-ml-service`

---

## Evidence Status

> **INSUFFICIENT_EVIDENCE** — No production dataset is available in the test environment. All label statistics in this report are derived from deterministic synthetic price paths used in unit tests, not from real Indian equity/F&O market data. This is the correct reporting posture; fabricating statistics from a real dataset that has not been loaded would be worse than reporting the honest evidence gap.

---

## Test Results

| Metric | Value |
|--------|-------|
| Python | 3.14.6 |
| pytest | 9.1.1 |
| Collected | 63 |
| **Passed** | **61** |
| Failed | 0 |
| Skipped | 2 (pre-existing env constraints) |
| Pass rate | 96.8% |
| **Verdict** | **PASS** |

### Skipped Tests

- `TestPurgingContract::test_overlapping_event_removed_by_purging` — `sklearn` not installed (pre-existing)
- `TestPipelineIntegration::test_generate_risk_labels_uses_first_touch` — `talib` not installed (pre-existing)

These two tests exercise real boundary conditions and must be enabled in the production CI environment where both packages are available.

---

## Bugs Fixed During Task 12

### BUG-3C-001 — CRITICAL: ATR fraction 100× too large on first bar

**Component:** `src/labels/triple_barrier.py` → `_compute_atr_at_bar()`

**Symptom:** All golden-path tests failed with `TIME_LIMIT` instead of `TAKE_PROFIT` or `STOP_LOSS`. Barriers were ±100% of entry price instead of ±1-2%.

**Root cause:** The early-return branch for a single-bar window returned `float(c.iloc[-1]) * 0.01`. For a ₹100 stock this equals `1.0` — a 100% ATR fraction — making TP = 200 and SL = 0. The correct return is the scalar `0.01` (1%), independent of price level.

**Fix:**
```python
# Before
return float(c.iloc[-1]) * 0.01 if len(c) >= 1 else 0.01

# After
return 0.01  # 1% default ATR fraction, independent of price
```

**Impact:** This bug would have caused nearly every triple-barrier event on the first `volatility_window` bars of any new symbol to be incorrectly classified as `TIME_LIMIT`. This is a silent correctness failure — no exception is raised, labels simply look plausible (TIME_LIMIT is a valid outcome) while being factually wrong.

---

### BUG-3C-002 — HIGH: Contract expiry not applied to incomplete-horizon events

**Component:** `src/labels/triple_barrier.py` → `generate_triple_barrier_labels()`

**Symptom:** Events starting past `contract_expiry` were generated. Events at the dataset tail (marked `is_incomplete`) had `event_end_time` set to the last bar of the dataset, ignoring the expiry cap.

**Root cause:** The expiry check (`if bt > contract_expiry: break`) was inside the forward scan loop. The `is_incomplete` early-exit path bypassed that loop entirely.

**Fix:**
- Added expiry cap in the `is_incomplete` path (scan backwards from the event start to find the last bar ≤ expiry).
- Added guard at loop entry: `if t0_dt >= contract_expiry: continue`.

---

### BUG-3C-003 — HIGH: `pd.Timestamp(tz_aware_dt, tz='UTC')` fails in pandas ≥ 2.x

**Component:** `src/labels/sample_weights.py`, `src/labels/risk_outcomes.py`

**Symptom:** `ValueError: Cannot pass a datetime or Timestamp with tzinfo with the tz parameter. Use tz_convert instead.` — raised on Python 3.14 / pandas 2.x in 8 tests.

**Root cause:** All event timestamps carry `timezone.utc` (they are `datetime` objects from the schemas). Passing `tz="UTC"` alongside an already-tz-aware datetime is rejected in newer pandas.

**Fix:** Added `_to_ts()` helper in both files:
```python
def _to_ts(dt) -> pd.Timestamp:
    ts = pd.Timestamp(dt)
    if ts.tzinfo is None:
        return ts.tz_localize("UTC")
    return ts.tz_convert("UTC")
```

---

## Static Analysis — `shift(-N)` in Label Paths

Command: `grep -rn "shift(-" src/labels/ src/training/ --include="*.py"`

| File | Line | Code | Classification |
|------|------|------|----------------|
| `src/labels/relative.py` | 247 | `peer_fwd = peer.shift(-horizon) / peer - 1.0` | **LABEL_ONLY** — sector peer forward return for label target |
| `src/training/data_pipeline.py` | 613 | `df[label_col].shift(-horizon)` | **LABEL_ONLY** — leakage detector reference, not a feature |
| `src/training/data_pipeline.py` | 661 | `df[label_col].shift(-horizon)` | **LABEL_ONLY** — leakage detector check 2, not a feature |
| `src/training/data_pipeline.py` | 843 | `fwd = returns.shift(-horizon)` | **LABEL_ONLY** — vol-adjusted ranking label target |

**Verdict: CLEAN.** All `shift(-N)` occurrences are in label-generation or label-validation code paths. None are in feature engineering paths that could be fed into a model.

---

## Label Modules Implemented

| Module | Status | Key Invariants |
|--------|--------|----------------|
| `labels/config.py` | ✅ | Deterministic hash; cost model `DATA_UNAVAILABLE` by default |
| `labels/schemas.py` | ✅ | `LabelEvent`, `TripleBarrierLabel`, `FixedHorizonLabel`, `RiskOutcomeLabel`, `MetaLabel`; `FirstTouch`, `Side`, `LabelFamily` enums |
| `labels/triple_barrier.py` | ✅ | Sequential scan; first-touch semantics; `CONSERVATIVE_SL`/`DATA_AMBIGUOUS` policy; `is_incomplete` → `DATA_INSUFFICIENT` (never `TIME_LIMIT`); long+short; expiry-aware |
| `labels/fixed_horizon.py` | ✅ | Raw/vol-adj/directional; UTC-aware; tail completeness |
| `labels/meta_label.py` | ✅ | `TAKE`/`SKIP`; side-separated; `DATA_INSUFFICIENT` excluded |
| `labels/risk_outcomes.py` | ✅ | MFE ≥ 0 / MAE ≤ 0 signed convention; long+short |
| `labels/sample_weights.py` | ✅ | Concurrency; average uniqueness; `build_t1_from_events()` |
| `labels/relative.py` | ✅ | Excess return vs NIFTY; sector-relative with `DATA_UNAVAILABLE` policy |
| `labels/validators.py` | ✅ | 7 leakage rules; PIT mutation check |
| `labels/registry.py` | ✅ | Active + deprecated label registry; config hash lookup |

---

## Pipeline Integration

| Check | Result |
|-------|--------|
| `generate_risk_labels()` delegates to V2 (sequential scan) | ✅ |
| `generate_ranking_labels_v2()` returns `pd.Series` (backward compat) | ✅ |
| `generate_labels()` public API routes by `label_id` | ✅ |
| `validate_labels()` raises `RuntimeError` on CRITICAL violation | ✅ |
| `LABEL_VERSION == 'lv2'` | ✅ |
| `DatasetSnapshot` has 14 new label provenance fields | ✅ |
| `attach_label_diagnostics()` method added | ✅ |

---

## Label Distribution Statistics

**Status: INSUFFICIENT_EVIDENCE**

No real dataset was loaded during this phase. The following characterisations are expected values based on published research (López de Prado, 2018) and the structure of Indian equity daily data, NOT observed values:

| Outcome | Expected range (Indian daily equity) | Basis |
|---------|--------------------------------------|-------|
| TAKE_PROFIT | 20–35% | Estimated; depends on ATR multiplier and market regime |
| STOP_LOSS | 15–30% | Estimated |
| TIME_LIMIT | 35–60% | Estimated; expected majority in sideways markets |
| DATA_INSUFFICIENT | ~5% | Tail bars only |
| INTRABAR_AMBIGUOUS | < 2% | Daily OHLC data; ambiguity rare at daily granularity |

These estimates must be replaced with observed values on real data before Phase 3D begins.

---

## Known Limitations

1. **No real dataset** — All label distribution metrics are `INSUFFICIENT_EVIDENCE`.
2. **sklearn not installed** — PurgedKFold integration test skipped in this environment.
3. **talib not installed** — Pipeline ATR integration test skipped.
4. **Cost model `DATA_UNAVAILABLE`** — Net returns not computed until broker API costs are populated.
5. **Intraday ambiguity unresolvable** — OHLC bars cannot determine intra-bar first-touch order. This is a data limitation, not a code limitation.
6. **Sector peer universe offline** — Sector-relative labels return `DATA_UNAVAILABLE` without a live data feed.
7. **ATR barrier calibration** — The `min_volatility=0.01` floor and `pt_multiplier`/`sl_multiplier` defaults have not been calibrated against real Indian equity volatility profiles.

---

## Statistical Risks Remaining

| Risk | Severity | Status |
|------|----------|--------|
| Class imbalance in TP/SL/TIME_LIMIT | Medium | Mitigated by `compute_average_uniqueness()` and meta-label; full characterisation requires real data |
| Intrabar ambiguity rate on daily data | Low | Tracked in `LabelDiagnostics.ambiguous_count`; expected < 2% on daily |
| ATR barriers too tight on high-volatility F&O underlyings | Medium | Deferred to Phase 3D per-symbol calibration |
| Event overlap fraction / PurgedKFold embargo tuning | Medium | `build_t1_from_events()` correct; embargo_pct tuning deferred to Phase 3D |

---

## Backward Compatibility

| Consumer | Status | Notes |
|----------|--------|-------|
| `train_all.py` (uses `y_stop`, `y_target`, `y_drawdown`) | ✅ Unbroken | `generate_risk_labels()` delegates to V2 but returns same `(y_stop, y_target, y_mae)` tuple |
| `PurgedKFold` (uses `t1` series) | ✅ Compatible | `build_t1_from_events()` produces correctly structured `t1` Series |
| `generate_ranking_labels_v2()` (returns `pd.Series`) | ✅ Unbroken | Compat wrapper in `relative.py` |
| `DatasetSnapshot` existing fields | ✅ Unbroken | Only additive; no existing fields removed or renamed |
| Existing lv1 label functions in `models/` | ✅ Unchanged | Not touched; lv1 functions remain in place for `market_regime.py`, `stock_ranker.py` |
