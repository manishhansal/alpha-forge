# Phase 3 Readiness Assessment

**Verification Date:** 2026-09-06  
**Assessor:** Independent post-audit verification  
**Branch:** `refactor/improve-ml-service`

---

## 1. Decision

# ❌ BLOCK_PHASE_3

---

## 2. Basis for Decision

Phase 3 (the "Research Truth Layer") cannot proceed because the following critical issues in the production codebase have been independently verified and remain unresolved:

| # | Issue | Severity | Evidence |
|---|---|---|---|
| B1 | Random shuffle splits in `train_all.py` for regime and strategy models | 🔴 CRITICAL | `train_all.py` lines 50, 130 — `train_test_split(stratify=y)` confirmed |
| B2 | Look-ahead bias in `detect_bos_choch()` via `center=True` | 🔴 CRITICAL | `market_structure.py` lines 136-137 confirmed |
| B3 | Validation framework entirely disconnected from training | 🔴 CRITICAL | No import of `WalkForwardValidator` or `PurgedKFold` in `train_all.py` |
| B4 | `ModelAcceptanceGate` never called; models saved regardless of OOS quality | 🔴 CRITICAL | No import in `train_all.py` confirmed |
| B5 | No transaction costs in any label generation | 🔴 HIGH | Zero results for "transaction_cost", "brokerage", "stt" in entire `src/` |
| B6 | Static training universe — survivorship bias | 🔴 HIGH | `TRAINING_UNIVERSE` is hardcoded; no PIT registry exists |
| B7 | No F&O ban list filtering | 🔴 HIGH | Zero results for "ban_list", "mwpl", "fno_ban" in entire `src/` |
| B8 | All 11 models are HEURISTIC — no trained artifacts, no OOS evidence | 🔴 CRITICAL | No artifacts in repo; all inference paths use fallback heuristics |
| B9 | Test suite is broken in the CI environment (148 failures due to missing dependencies) | 🔴 HIGH | Confirmed: `sklearn`, `scipy`, `talib`, `riskfolio` not installed |
| B10 | `train_all.py` has zero test coverage | 🔴 HIGH | No test file exists for this module |

**None of B1-B10 were introduced by Prompts 1 or 2. They pre-existed in master and were only documented by those prompts.**

Proceeding to Phase 3 (implementing the Research Truth Layer — more ML, more models, more complexity) on top of a foundation with these active bugs would:
1. Train Phase 3 models on contaminated data, producing invalid OOS metrics
2. Add complexity to a system that cannot currently produce any validated ML signal
3. Make the existing bugs harder to identify and fix
4. Risk creating a false impression that the system is ML-powered when it is 100% heuristic

---

## 3. Exact Corrections Required Before Phase 3

All items in the BLOCKING category (B1-B10) must be resolved. Each item below has a specific success criterion that must be independently verifiable.

---

### FIX-01: Replace random splits with temporal splits in train_all.py

**File:** `src/training/train_all.py`  
**Functions:** `train_regime_model()`, `train_strategy_model()`  
**Action:**
```python
# REMOVE:
from sklearn.model_selection import train_test_split
X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, stratify=y)

# REPLACE WITH:
from src.validation import WalkForwardValidator, WalkForwardConfig
cfg = WalkForwardConfig(train_bars=504, val_bars=63, test_bars=63)
wfv = WalkForwardValidator(cfg)
folds = wfv.split(len(X))
# Use last fold for train/val; aggregate OOS on test folds
```
**Success criterion:** `ast.walk(ast.parse(open('train_all.py').read()))` finds no `train_test_split` import.

---

### FIX-02: Remove center=True from detect_bos_choch()

**File:** `src/features/market_structure.py`  
**Lines:** 136-137  
**Action:**
```python
# CHANGE:
swing_high = high.rolling(window=lookback * 2 + 1, center=True).max()
swing_low  = low.rolling(window=lookback * 2 + 1, center=True).min()

# TO:
swing_high = high.rolling(window=lookback * 2 + 1, min_periods=lookback + 1).max()
swing_low  = low.rolling(window=lookback * 2 + 1, min_periods=lookback + 1).min()
```
**Success criterion:** `grep -n "center=True" src/features/market_structure.py` returns no results.

---

### FIX-03: Add embargo at ranking and risk train/val boundary

**File:** `src/training/train_all.py`  
**Functions:** `train_ranking_model()`, `train_risk_model()`  
**Action:** Apply `EmbargoApplier(EmbargoConfig.bars(5))` for ranking; `EmbargoApplier(EmbargoConfig.bars(20))` for risk.  
**Success criterion:** Test verifies no training sample within `horizon` bars of the val boundary.

---

### FIX-04: Wire ModelAcceptanceGate into training pipeline

**File:** `src/training/train_all.py`  
**Action:** After each model trains and evaluates on OOS test fold(s):
```python
gate = ModelAcceptanceGate()
decision = gate.evaluate(oos_result)
if not decision.accepted:
    logger.error("model_rejected_by_gate", reasons=decision.reasons)
    raise ValueError(f"Model failed acceptance gate: {decision.reasons}")
model.save(save_path)  # Only reached if gate passes
```
**Success criterion:** A model with negative OOS Sharpe cannot be saved.

---

### FIX-05: Fix IV rank fallback

**File:** `src/features/engineer.py` line 343  
**Action:**
```python
# CHANGE:
iv_history if iv_history else [15, 18, 20, 22, 25]
# TO:
iv_history if iv_history else []  # let compute_iv_rank() return 50.0 via its own guard
```
**Success criterion:** When `iv_history=[]`, `compute_iv_rank()` returns 50.0.

---

### FIX-06: Fix VWAP for daily bars

**File:** `src/features/volume.py`  
**Action:** Replace `cumsum()` with rolling N-day VWAP:
```python
N = 20  # or configurable
vwap = (typical_price * volume).rolling(N).sum() / volume.rolling(N).sum().replace(0, np.nan)
```
**Success criterion:** VWAP at bar 200 of a 200-bar series is the 20-day rolling VWAP, not the 200-day cumulative.

---

### FIX-07: Fix the test environment

**Action:** Install required test dependencies:
```bash
cd ml-service && pip install scikit-learn scipy TA-Lib riskfolio
```
Or add them to a `requirements-dev.txt` and document the install command.  
**Success criterion:** `python3 -m pytest tests/ --co -q` collects ≥ 200 tests without errors.

---

### FIX-08: Add test for train_all.py temporal split

**File:** `tests/test_train_all.py` (new file)  
**Action:**
```python
def test_no_random_split_in_train_all():
    import ast
    src = open("src/training/train_all.py").read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            names = [a.name for a in node.names]
            assert "train_test_split" not in names, \
                "train_all.py must not use train_test_split — temporal leakage"
```
**Success criterion:** Test passes and is part of the CI pipeline.

---

### FIX-09: Add NSE transaction cost model

**File:** `src/training/data_pipeline.py`  
**Action:** Define and apply:
```python
NSE_ROUNDTRIP_COST_PCT = 0.25  # conservative for F&O futures
# In generate_ranking_labels_v2():
net_excess = gross_excess - NSE_ROUNDTRIP_COST_PCT / 100
```
**Success criterion:** Ranking labels reflect net-of-cost excess returns.

---

### FIX-10: Add NSE F&O expiry calendar

**File:** `src/features/macro.py` or new `src/calendar.py`  
**Action:** Embed NSE weekly expiry dates (Tuesday since Sep 1, 2025):
```python
def get_days_to_expiry(date: pd.Timestamp) -> tuple[int, bool]:
    """Returns (days_to_weekly_expiry, is_expiry_day) from NSE calendar."""
    ...
```
**Success criterion:** `is_expiry_day` is computed from a real calendar, not caller-supplied with default=5.

---

## 4. Items NOT Required for Phase 3 (Can Follow)

The following are important but do not block Phase 3 if the BLOCKING items above are resolved:

| Item | Phase |
|---|---|
| Survivorship bias (PIT universe registry) | Phase 4 — requires external data source |
| F&O ban list | Phase 3 — add as part of Phase 3 signal integrity work |
| CalibrationStore OOS quality metrics | Phase 3 |
| ModelRegistry weights in EnsembleWeighter | Phase 3 |
| Triple-barrier labels (MlFinLab) | Phase 3 |
| Sample weights for overlapping labels | Phase 3 |
| IV carry feature | Phase 3 |
| Deflated Sharpe Ratio | Phase 3 |
| MLflow experiment tracking | Phase 3 |

---

## 5. Phase 3 Prerequisites (If All Blocking Items Fixed)

Once FIX-01 through FIX-10 are verified, Phase 3 may proceed with the following constraints:

1. **Phase 3 must be on a separate branch** from this audit branch
2. **First commit of Phase 3 must run the full test suite** — all existing tests must pass
3. **Phase 3 may not claim OOS performance** until at least one model has completed the full walk-forward validation sequence (FIX-01 → ModelAcceptanceGate → ≥252 OOS trading days)
4. **Phase 3 additions must not add new random splits** anywhere in the training pipeline
5. **Phase 3 additions must not add new center=True rolling windows**
6. **Phase 3 must include a "INSUFFICIENT_EVIDENCE" guard** at the API level: if no validated model exists, the `/decide` endpoint must return `NO_TRADE` with reason `"insufficient_oos_evidence"`, not a heuristic BUY/SELL

---

## 6. Summary Scorecard

| Requirement | Met? |
|---|---|
| No temporal leakage in training | ❌ |
| No look-ahead in features | ❌ |
| Validation framework used in training | ❌ |
| Evidence gate before model save | ❌ |
| Transaction costs in labels | ❌ |
| Test suite passes | ❌ |
| train_all.py has tests | ❌ |
| At least one model with OOS IC > 0.02 | ❌ |
| F&O ban list filtering | ❌ |
| NSE expiry calendar | ❌ |

**0 / 10 requirements met.**

**Decision: BLOCK_PHASE_3**
