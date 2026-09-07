# AlphaForge ML Service — Data Audit

**Audit Date:** 2026-09-06  
**Scope:** `training/data_pipeline.py`, `training/market_data_client.py`, `training/train_all.py`

---

## 1. Data Sources

### 1.1 Source Hierarchy

The data client implements a tiered fallback chain:

```
Tier 1: AlphaForge API (Angel One primary / Upstox fallback)
  └─ /historical          — OHLCV candles
  └─ /option-chain/history — daily OC snapshots (PCR, IV, OI walls, max pain)
  └─ /market-breadth      — advance/decline, % above SMAs
  └─ /vix                 — India VIX daily series

Tier 2: PostgreSQL (option_chain_snapshots, price_history tables)
  └─ Direct DB query when Tier 1 is unreachable

Tier 3: yfinance
  └─ OHLCV only — NO open interest, derivatives, PCR, or IV data
  └─ Explicitly marked as last resort in code comments
```

**Assessment:** The tiered fallback is well-designed. The `_normalize_ohlcv_frame()` method correctly normalises field names (including Angel One short names: `o`, `h`, `l`, `c`, `v`), enforces UTC DatetimeIndex, and attaches `_quality` and `_source` columns. This is production-grade.

### 1.2 Training Universe

```python
TRAINING_UNIVERSE: list[str] = [
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", ...  # ~50 symbols
]
```

**CRITICAL: Survivorship Bias**  
This is a static hardcoded list of stocks as they exist today. Stocks that were once in the F&O universe but have been delisted or removed (e.g., Vodafone Idea at certain periods, Yes Bank, various small-caps that entered and exited the F&O list) are absent from training history. Models trained on this universe learn from a selection of stocks that survived — inflating apparent predictive performance.

**No point-in-time universe membership records are stored or used.** There is no mechanism to determine which stocks were eligible for trading on a given historical date.

---

## 2. Data Normalization

### 2.1 OHLCV Normalization

`AlphaForgeAPIClient._normalize_ohlcv_frame()` correctly:
- Maps multiple field-name variants (Angel One, Upstox, standard)
- Enforces `float64` dtype on all price/volume columns
- Converts timestamp to UTC `DatetimeIndex`
- Marks rows with quality flags (`VALID`, `STALE`, `INVALID`, `SUSPICIOUS`)
- Attaches source metadata

**Assessment: KEEP — production-quality normalization.**

### 2.2 Derivatives Normalization

`DerivativesSnapshot` is a typed dataclass covering:
- PCR (OI-based), ATM IV, IV rank, IV percentile, ATM skew
- Max pain, max CE OI strike, max PE OI strike
- Total CE/PE OI and OI changes
- OI concentration metric

Forward-fill in `enrich_with_derivatives()` is correctly limited to 5 bars (`ffill(limit=5)`), preventing indefinite propagation of stale option chain data.

**One concern:** The forward-fill window of 5 bars is hard-coded. Near expiry (Thursday for weekly options), derivative characteristics change rapidly. A 5-bar fill of a Thursday snapshot into the following Monday treats the new-contract IV/PCR as if it were the expiring contract's values.

---

## 3. Data Quality Filtering

### 3.1 Quality Classifications

```python
class DataQuality(str, Enum):
    VALID       = "valid"
    STALE       = "stale"        # > 5-bar gap since last update
    INVALID     = "invalid"      # failed normalization
    SUSPICIOUS  = "suspicious"   # statistical anomalies (spike detection)
```

**Assessment:** Quality filtering is present and non-trivial. Suspicious rows (extreme OHLC ratios, zero-volume days) are flagged. However, the filtering thresholds are not documented in the code — no comment explains what ratio threshold triggers SUSPICIOUS.

### 3.2 Missing Data Handling

- Missing derivatives: `_build_derivatives_dict(None)` returns `{}`, causing `compute_stock_features()` to use default values (0.0 for most derivative features). This is correct — models must handle absent OI data gracefully.
- Missing VIX: `compute_vix_features(None)` returns sensible defaults (level=15, regime=1, percentile=50). Acceptable.
- Missing breadth data: Returns 50% defaults. Acceptable.

---

## 4. Dataset Versioning

`data_pipeline.py` defines:
```python
PIPELINE_VERSION = "v3.0"
FEATURE_VERSION  = "fv4"
DATASET_VERSION  = f"af-{PIPELINE_VERSION}-{FEATURE_VERSION}"
```

And `_compute_universe_fingerprint()` creates a short SHA1 hash of the sorted universe list. Metadata is saved as a JSON sidecar alongside each `.npz` training file.

**This is a genuine strength.** Dataset versioning allows trained artifacts to be traced back to a specific pipeline and feature version.

**Gap:** The `ModelRecord` in `model_registry.py` is populated with hardcoded placeholder strings (`"ds-baseline-v1"`, `"feat-v1"`) in `build_default_registry()` rather than being automatically injected at training time. The version chain breaks at model registration.

---

## 5. Walk-Forward Data Construction

`build_regime_training_data()` and `build_ranking_training_data()` both implement correct point-in-time feature construction:

```python
# Feature window: ends at bar i (current bar inclusive)
nifty_window = nifty_df.iloc[max(0, i - lookback) : i + 1]

# Label: strictly forward
fwd_return = close.shift(-lookforward) / close - 1  # bar i+1 ... i+lookforward
```

This is correct. The forward label is computed from future data (intentionally), but features never cross into that window.

**Assessment: KEEP — point-in-time barriers are correctly implemented in data_pipeline.py.**

---

## 6. Corporate Actions

**No evidence of split/dividend/bonus adjustment in any data client code.**  
The `_normalize_ohlcv_frame()` method does not check for or apply corporate action adjustments. Angel One and Upstox APIs may or may not return adjusted prices — this is not validated.

For a backtesting system, unadjusted historical OHLCV data for stocks with splits or bonuses (e.g., Reliance 1:1 bonus in 2017, TCS buybacks) will show apparent gaps or discontinuities that corrupt momentum features, ATR calculations, and distance-from-high/low metrics.

**Risk: HIGH** — particularly for longer training windows (>2 years) where corporate actions are frequent.

---

## 7. F&O Expiry Calendar

`compute_expiry_features()` in `features/macro.py` accepts `days_to_weekly_expiry` and `days_to_monthly_expiry` as inputs. These are computed by the caller, not by the feature engineering layer itself.

**Gap:** No F&O expiry calendar is embedded in the system. The data pipeline does not automatically compute expiry proximity from a known NSE expiry schedule. The caller must supply `days_to_weekly_expiry` correctly; if it is missing, the default of 5 days is used. On actual weekly expiry days (Thursday), this produces wrong expiry features.

---

## 8. Data-to-Feature Traceability

| Data item | Feature derived | Location | Point-in-time safe? |
|---|---|---|---|
| OHLCV close | RSI, MACD, momentum | `technical.py`, `momentum.py` | ✅ |
| OHLCV volume | Relative volume, VPIN | `volume.py` | ✅ |
| PCR (OI) | `pcr_score` | `derivatives.py` | ✅ |
| ATM IV | `iv_rank`, `atm_iv` | `derivatives.py` | ✅ (when history provided) |
| OI change | `oi_buildup_score` | `derivatives.py` | ✅ |
| High/Low | Swing highs/lows for BOS | `market_structure.py` | ❌ `center=True` look-ahead |
| NIFTY close | `relative_strength_vs_nifty` | `momentum.py` | ✅ |
| VIX | `vix_regime`, `vix_percentile` | `macro.py` | ✅ |
| Breadth data | `advance_decline_ratio` | `macro.py` | ✅ |
| Session time | `session_progress`, `is_opening_zone` | `macro.py` | ✅ |

---

## 9. Recommendations

| Priority | Action |
|---|---|
| 🔴 CRITICAL | Build point-in-time universe membership registry before any historical backtest |
| 🔴 CRITICAL | Verify corporate action adjustment status for all OHLCV data sources |
| 🔴 HIGH | Embed actual NSE weekly/monthly expiry calendar in data_pipeline.py |
| 🟡 MEDIUM | Auto-inject `DATASET_VERSION` and universe fingerprint into `ModelRecord` at training time |
| 🟡 MEDIUM | Document quality-flag thresholds (SUSPICIOUS spike detection) |
| 🟡 MEDIUM | Reduce forward-fill limit to 2 bars near weekly expiry; tag post-expiry bars |
| 🟢 LOW | Add schema validation (column presence + dtype) to `_normalize_ohlcv_frame()` output |
