# Phase 3B: Point-in-Time Data Foundation

**Implementation Date:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`  
**Phase:** 3B — Point-in-Time Data Foundation  
**Status:** COMPLETE — PHASE_3B_PASS

---

## 1. Overview

Phase 3B establishes the data truth layer required for statistically valid ML training. Every ML observation must now answer:

- **What data existed** at prediction time?
- **When did it become available** (not just when did the market event occur)?
- **Which instrument/contract was valid** at that historical date?
- **Whether the observation was actually tradable** (not banned, eligible in F&O)?
- **What corporate actions had been announced** by prediction time?
- **What data is genuinely unavailable** vs silently substituted?

The fundamental invariant enforced throughout:

```
available_time <= prediction_time
```

---

## 2. New Package: `ml-service/src/data/`

```
ml-service/src/data/
├── __init__.py
├── point_in_time.py      PointInTimeRecord, PointInTimeValidator, timezone helpers
├── lineage.py            MLObservationLineage, DatasetLineage, source fingerprinting
├── dataset_version.py    DatasetSnapshot, DatasetVersionRegistry
├── instrument_master.py  HistoricalInstrumentRecord, InstrumentMasterStore (PIT lot sizes)
├── historical_universe.py UniverseMembership (5-dimensional), HistoricalUniverse
├── corporate_actions.py  CorporateActionRecord, CorporateActionStore
├── fno_eligibility.py    FnOEligibilityRecord, FnOBanRecord, FnOStateStore
└── data_quality.py       MLDataQualityIssue, MLDataQualityReport, MLDataQualityGate
```

---

## 3. Core Data Contract

### 3.1 Three Timestamps Per Observation

Every ML training observation now has three distinct timestamps:

| Timestamp | Definition | Example (NSE daily close 2023-06-01) |
|---|---|---|
| `event_time` | When the market event occurred | 2023-06-01 10:00 UTC (15:30 IST) |
| `available_time` | When AlphaForge could use this datum | 2023-06-01 10:30 UTC (16:00 IST — Bhavcopy published) |
| `ingestion_time` | When ml-service recorded it | Actual fetch timestamp |

The `available_time` is what enforces PIT correctness. A model prediction at 10:15 UTC cannot use data that only became available at 10:30 UTC.

### 3.2 Timezone Semantics

- **Internal representation:** UTC always (`timezone.utc`)
- **Market-local display:** `Asia/Kolkata` (IST = UTC+5:30, no DST)
- **Naive datetimes:** Rejected with `ValueError` at every entry point
- **NSE session boundaries:**
  - Open: 09:15 IST = 03:45 UTC
  - Close: 15:30 IST = 10:00 UTC
  - Bhavcopy published: ~16:00 IST = 10:30 UTC (estimated)

### 3.3 Revision Handling

When multiple revisions exist for the same `(symbol, event_time)`:

```python
# Policy: select latest revision whose available_time <= prediction_time
best = select_best_revision(revisions, prediction_time=query_time)
```

This guarantees that future corrections cannot alter what was available at any historical prediction time.

---

## 4. Historical Universe (5-Dimensional)

Universe membership is **not** a single boolean. Five independent dimensions:

| Dimension | Meaning | Current Status |
|---|---|---|
| `FO_ELIGIBLE` | In NSE F&O lot-size list on this date | DATA_UNAVAILABLE (uses current list as APPROXIMATE) |
| `FO_BANNED` | In NSE MWPL >95% ban list on this date | DATA_UNAVAILABLE always |
| `TRADABLE` | FO_ELIGIBLE AND NOT FO_BANNED | DATA_UNAVAILABLE (derived) |
| `DATA_AVAILABLE` | OHLCV+derivatives data exists | Set by data_pipeline.py |
| `LIQUID` | Passes minimum volume/OI threshold | Requires volume data |
| `MODEL_ELIGIBLE` | All of the above are TRUE | DATA_UNAVAILABLE without history |

**Lenient mode** (default, for research): Symbols in the current TRAINING_UNIVERSE list are treated as APPROXIMATE TRUE for FO_ELIGIBLE. A WARNING is logged.

**Strict mode**: All symbols return DATA_UNAVAILABLE for FO_ELIGIBLE. Only explicitly registered eligibility is accepted.

---

## 5. Instrument Master (Time-Aware Lot Sizes)

The static `LOT_SIZES` dict in `data_pipeline.py` is replaced by `InstrumentMasterStore.get_lot_size(symbol, date)`.

### Known Lot-Size Changes

| Symbol | Period | Lot Size | Source |
|---|---|---|---|
| NIFTY | Before 2024-11-01 | 50 | BEST_KNOWN |
| NIFTY | From 2024-11-01 | 75 | BEST_KNOWN (SEBI Nov 2024) |
| BANKNIFTY | Before 2024-11-01 | 15 | BEST_KNOWN |
| BANKNIFTY | From 2024-11-01 | 30 | BEST_KNOWN (SEBI Nov 2024) |
| FINNIFTY | Before 2024-11-01 | 40 | BEST_KNOWN |
| FINNIFTY | From 2024-11-01 | 65 | BEST_KNOWN (SEBI Nov 2024) |
| MIDCPNIFTY | Before 2024-11-01 | 75 | BEST_KNOWN |
| MIDCPNIFTY | From 2024-11-01 | 120 | BEST_KNOWN (SEBI Nov 2024) |
| Stock F&O | All periods | Current value | APPROXIMATE |

**Critical invariant proven by test:** Adding a future lot-size entry cannot change the result of a past query.

---

## 6. Corporate Actions (DATA_UNAVAILABLE Policy)

AlphaForge does not currently maintain a historical corporate-action database.

```python
store = CorporateActionStore.empty()
result = store.get_adjusted_price("RELIANCE", date(2023, 6, 1), raw_price=2500.0)
# result.status == AdjustmentStatus.DATA_UNAVAILABLE
# result.raw_price == 2500.0  (always returned as fallback)
# result.adjusted_price == None  (not fabricated)
```

**Critical invariant:** A future corporate action (announced after query_date) cannot adjust prices for pre-announcement dates, even when the store contains that action.

---

## 7. F&O Ban State (DATA_UNAVAILABLE Policy)

```python
store = FnOStateStore.empty()
state = store.get_fno_state("RELIANCE", date(2023, 6, 1))
# state.ban_status == BanStatus.DATA_UNAVAILABLE
# state.is_tradable == None  (cannot determine)
# state.notes explains the limitation
```

When a ban record IS registered, the store correctly returns BANNED and NOT_BANNED for dates within the known range.

---

## 8. Dataset Snapshot

Every `.npz` training artefact now has a companion `_snapshot.json` file with full provenance:

```json
{
  "dataset_id": "uuid",
  "dataset_version": "af-v3.1-fv4-lv1",
  "schema_version": "3b.0",
  "created_at": "2026-09-06T...",
  "git_commit": "3af60a8",
  "pipeline_version": "v3.1",
  "feature_version": "fv4",
  "label_version": "lv1",
  "source_fingerprint": "sha256_16chars",
  "universe_version": "static-v1",
  "instrument_master_version": "best-known-v1",
  "corporate_action_version": "DATA_UNAVAILABLE",
  "training_start": "...",
  "training_end": "...",
  "symbol_count": 50,
  "row_count": 12600,
  "quality_status": "HAS_WARNINGS",
  "limitations": [
    "UNIVERSE_SURVIVORSHIP_BIAS: ...",
    "CORPORATE_ACTION_UNADJUSTED: ...",
    "FO_BAN_HISTORY_UNAVAILABLE: ...",
    "TRANSACTION_COSTS_EXCLUDED: ..."
  ]
}
```

**Reproducibility invariant proven by test:** Same source_versions → same source_fingerprint. Different source_versions → different fingerprint.

---

## 9. Data Quality Gate (12 Checks)

The `MLDataQualityGate` runs before feature engineering with 12 checks:

| Check | Severity | Description |
|---|---|---|
| MISSING_COLUMNS | CRITICAL | Required OHLCV columns absent |
| EMPTY_DATASET | CRITICAL | Zero rows |
| INVALID_PRICE | CRITICAL | Zero/negative OHLC |
| NEGATIVE_VOLUME | CRITICAL | Negative volume |
| HIGH_LESS_THAN_LOW | CRITICAL | High < Low |
| NAIVE_TIMESTAMP_INDEX | CRITICAL | DatetimeIndex has no timezone |
| PIT_VIOLATION | CRITICAL | available_time > prediction_time |
| CLOSE_OUTSIDE_RANGE | ERROR | Close not in [low, high] |
| NAN_VALUES | ERROR | NaN in OHLCV |
| DUPLICATE_TIMESTAMPS | ERROR | Duplicate index values |
| INSUFFICIENT_ROWS | ERROR | Fewer than 20 rows |
| EXTREME_PRICE_MOVE | WARNING | >25% single-bar move |
| STALE_BARS | WARNING | Unchanged price + zero volume ≥3 bars |

CRITICAL and ERROR findings block dataset creation. WARNING findings produce `HAS_WARNINGS` quality status.

---

## 10. 7-Step Pre-Feature Validation in data_pipeline.py

Added `validate_observation_pit()` function that runs before every call to `compute_stock_features()`:

```
Step 1: Validate timestamps (no naive; no future available_time)
Step 2: Validate instrument identity (symbol in instrument master)
Step 3: Resolve historical universe (FO_ELIGIBLE / FO_BANNED / TRADABLE)
Step 4: Resolve contract metadata (lot size at bar_date, not today's)
Step 5: Resolve corporate action state (flag DATA_UNAVAILABLE)
Step 6: Resolve F&O ban state (flag DATA_UNAVAILABLE or BANNED)
Step 7: Run ML data quality gate (OHLCV integrity + PIT)
```

Result is `PITValidationResult` with status `DATA_READY` | `DATA_READY_WITH_WARNINGS` | `BLOCKED`.

---

## 11. Data Lineage

Every training observation gets an `observation_id` (UUID):

```python
obs_id = store.record(
    symbol="RELIANCE",
    data_type="OHLCV",
    provider="NSE_BHAVCOPY",
    event_time=event_dt,        # UTC-aware
    available_time=avail_dt,    # UTC-aware
    dataset_version="af-v3.1-fv4-lv1",
)
```

The `observation_id` links a training row to:
- Its source (NSE_BHAVCOPY, BROKER_ANGEL, etc.)
- Its exact event and availability timestamps
- Whether it was a fallback record
- Which dataset version it contributed to

---

## 12. Backward Compatibility

All existing APIs preserved:

- `/predict/regime`, `/predict/rank`, `/predict/risk`, `/predict/strategy` — **unchanged**
- `OHLCVRecord`, `DerivativesSnapshot` in `market_data_client.py` — **unchanged**
- `TRAINING_UNIVERSE` static list — **kept as fallback**; `get_pit_validated_universe()` is the new primary API
- `LOT_SIZES` static dict — **kept as fallback**; `get_lot_size(symbol, date)` is the new primary API
- `DatasetMetadata` JSON sidecar — **kept**; `DatasetSnapshot` JSON sidecar **added alongside**

---

## 13. Known Limitations (Explicit DATA_UNAVAILABLE)

The following capabilities require external historical data not currently in AlphaForge. All are documented explicitly in every `DatasetSnapshot.limitations` array:

| Limitation | Status | Impact |
|---|---|---|
| Historical F&O eligibility per date | DATA_UNAVAILABLE | Survivorship bias unresolved |
| Historical MWPL ban list per date | DATA_UNAVAILABLE | Some F&O-banned observations may be in training data |
| Corporate action price adjustments | DATA_UNAVAILABLE | Raw prices; splits/bonuses not adjusted |
| NSE lot-size history (stock F&O) | APPROXIMATE (current) | Minor errors for SEBI Nov 2024 affected stocks |
| Transaction costs in labels | NOT IMPLEMENTED | Gross returns only (Phase 3B deferred to later phase) |
| F&O expiry calendar (Tuesday since Sep 2025) | NOT IMPLEMENTED | Expiry features use caller-supplied values |

These limitations are **not silently papered over** — they are recorded as `DATA_UNAVAILABLE` in every dataset snapshot.

---

## 14. Test Results

| Test Class | Tests | Result |
|---|---|---|
| TestCorePITInvariant | 7 | ✅ All pass |
| TestTimezoneCorrectness | 7 | ✅ All pass |
| TestRevisionSelection | 5 | ✅ All pass |
| TestHistoricalUniverse | 6 | ✅ All pass |
| TestFnOBanState | 4 | ✅ All pass |
| TestInstrumentMasterLotSize | 7 | ✅ All pass |
| TestDatasetSnapshot | 6 | ✅ All pass |
| TestDataQualityGate | 8 | ✅ All pass |
| TestFutureRowDoesNotAlterHistory | 2 | ✅ All pass |
| TestCorporateActions | 3 | ✅ All pass |
| TestObservationLineage | 5 | ✅ All pass |
| TestDatasetVersionRegistry | 2 | ✅ All pass |
| TestPipelineIntegration | 5 | ✅ All pass |
| **Total** | **67** | **67 passed / 0 failed** |

Phase 3A tests: 39 pass, 7 skip (env), 0 fail — no regressions.
