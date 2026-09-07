# Phase 3B Pre-Implementation Design: Point-in-Time Data Foundation

**Date:** 2026-09-06  
**Status:** PRE-IMPLEMENTATION — approved for development  
**Scope:** ml-service only; data-service and Next.js app unchanged

---

## 1. Audit Summary: What Already Exists

### 1.1 data-service (reusable concepts — DO NOT duplicate)

| Component | Location | What it provides |
|---|---|---|
| `DataProvenance` | `data-service/src/core/schemas_v2.py` | `eventTimeMs`, `receivedAtMs`, `availableAtMs`, `dataObservationId` |
| `DataQualityGate` | `data-service/src/core/schemas_v2.py` | `signalEngineAllowed`, 5 gate conditions, `confidenceScore` |
| `DataQuality` | `data-service/src/core/schemas_v2.py` | VALID / DEGRADED / STALE / INVALID / UNKNOWN / PARTIAL |
| `DataSource` | `data-service/src/core/schemas_v2.py` | Canonical source enum (NSE_BHAVCOPY, BROKER_ANGEL, etc.) |
| `FreshnessClass` | `data-service/src/core/schemas_v2.py` | FRESH / AGING / STALE / EXPIRED / UNKNOWN |
| `DataLineageRecord` | `data-service/src/core/lineage.py` | Full lineage: obs_id, event/received/available timestamps, isFallback |
| `LineageStore` | `data-service/src/core/lineage.py` | In-memory LRU store with `record()`, `get()`, `get_by_instrument()` |
| `compute_dataset_fingerprint` | `data-service/src/core/lineage.py` | SHA-256 fingerprint from source+date+instruments+version |
| `TimestampEngine` | `data-service/src/engines/timestamp_engine.py` | UTC/IST conversion, NSE session detection, clock skew |
| `InstrumentMaster` | `data-service/src/scrapers/instrument_master.py` | TODAY's lot sizes from NSE fo_mktlots.csv; **NO historical effective dates** |

### 1.2 ml-service (current state — gaps to fill)

| Component | Location | Gap |
|---|---|---|
| `OHLCVRecord` | `market_data_client.py` | Missing `event_time`, `available_time`, `ingestion_time` |
| `DatasetMetadata` | `market_data_client.py` | Missing: `dataset_id`, `source_versions`, `universe_version`, `corporate_action_version`, `row_count`, `symbol_count`, `quality_status` |
| `LOT_SIZES` dict | `data_pipeline.py` line 107 | Static; no effective dates; breaks for contracts pre-SEBI Nov 2024 change |
| `TRAINING_UNIVERSE` | `data_pipeline.py` line 77 | Static; no PIT eligibility; survivorship bias |
| Nothing | — | No F&O ban state; no corporate actions; no PIT universe; no instrument history |

---

## 2. Reuse Plan

### 2.1 What the ml-service REUSES from data-service (mirror, don't import)

The data-service is a separate microservice. The ml-service does not import from it directly. Instead, we **mirror** the same enum values and timestamp semantics:

- `DataQualitySeverity` enum mirrors data-service `DataQuality` concepts
- UTC timestamps using `datetime` with `timezone.utc` (same as data-service)
- `ZoneInfo("Asia/Kolkata")` for IST conversion (same as data-service)
- `eventTime / availableTime / ingestionTime` timestamp triple (mirrors `eventTimeMs/receivedAtMs/availableAtMs`)
- SHA-256 dataset fingerprint (same algorithm)

### 2.2 What the ml-service adds (ML-specific, no live-signal concerns)

- **PointInTimeRecord** — single ML observation with full timestamp triple + revision tracking
- **PointInTimeValidator** — validates `available_time <= prediction_time` for every feature row
- **HistoricalInstrumentRecord** — instrument metadata with `effective_from / effective_to`
- **HistoricalUniverse** — PIT universe with `FO_ELIGIBLE / FO_BANNED / TRADABLE / DATA_AVAILABLE / LIQUID / MODEL_ELIGIBLE`
- **CorporateActionRecord** — split/bonus/merger with `effective_date / availability_date`
- **FnOEligibilityRecord** — NSE F&O eligibility with date range; ban state
- **MLDataQualityGate** — ML-specific (batch), different from live-signal gate (real-time)
- **DatasetSnapshot** — full provenance snapshot attached to every training dataset

### 2.3 What the ml-service does NOT duplicate

- Live-quote signal gating (that's data-service's job)
- WebSocket / tick data handling
- Provider circuit breakers
- The existing `DataQuality` enum in `market_data_client.py` (keep it, it works for OHLCV-level quality)

---

## 3. Data Contract Design

### 3.1 The fundamental PIT invariant

```
available_time <= prediction_time
```

Every ML observation must prove: "This datum was available to a trader at prediction_time."

Three distinct timestamps for every observation:
```
event_time     = when the market event occurred (exchange time)
available_time = when AlphaForge could use this datum (after publication/ingestion)
ingestion_time = when our system recorded it (for audit)
```

For NSE daily data:
- `event_time` = market close 15:30 IST = 10:00 UTC on the trading date
- `available_time` = typically `event_time + delay` where delay is:
  - OHLCV Bhavcopy: ~15-30 min after market close (published ~16:00-16:30 IST)
  - OI / Option chain data: ~15-30 min after close (NSE publishes by ~16:00 IST)
  - Market breadth: same day, published by ~17:00 IST
  - Fundamental data (delivery %): T+1 (next trading day morning)
- `ingestion_time` = when `market_data_client.py` fetched it

### 3.2 Revision semantics

When multiple revisions exist for the same `(symbol, event_time)`:

```
Revision A: available_at = 10:01:00 UTC
Revision B: available_at = 12:30:00 UTC (correction)

For prediction_time = 10:15:00 UTC:
  → Use Revision A  (most recent available at prediction_time)

For prediction_time = 14:00:00 UTC:
  → Use Revision B  (correction was available by then)
```

Policy: select the **latest revision whose `available_time <= prediction_time`**.

### 3.3 Timezone semantics

```
Internal representation:  UTC (all timestamps are timezone-aware)
Market-local representation:  Asia/Kolkata (IST = UTC+5:30)
UI representation:  IST with "IST" suffix

NEVER use naive datetimes anywhere in the ML pipeline.
NEVER assume "today's date in IST" without an explicit tzinfo.
```

NSE session in UTC:
```
Pre-open:     09:00 IST = 03:30 UTC
Session open: 09:15 IST = 03:45 UTC
Session close: 15:30 IST = 10:00 UTC
```

DST note: India does NOT observe DST. Asia/Kolkata is always UTC+5:30.

---

## 4. Historical Universe Semantics

Five independent boolean dimensions (NOT a single "eligible" flag):

```
FO_ELIGIBLE   — NSE has published this symbol in the F&O lot-size file
                 for the given date (quarterly revision)
FO_BANNED     — symbol is currently in the MWPL >95% ban list for this date
TRADABLE      — FO_ELIGIBLE AND NOT FO_BANNED
DATA_AVAILABLE — we have data for this symbol on this date
LIQUID        — sufficient volume/OI for the model (heuristic threshold)
MODEL_ELIGIBLE — TRADABLE AND DATA_AVAILABLE AND LIQUID
```

If historical F&O eligibility data is unavailable for a date:
- Return `FO_ELIGIBLE = DATA_UNAVAILABLE` (not True, not False)
- Do not fabricate eligibility
- Log the limitation

If historical ban data is unavailable for a date:
- Return `FO_BANNED = DATA_UNAVAILABLE`
- For research, this means the observation may be used with a WARNING
- For production, this means the observation is excluded

---

## 5. Corporate Action Semantics

```
raw_price      = exchange-reported price (unadjusted)
adjusted_price = price after applying corporate action factor
factor         = raw_price / adjusted_price (typically < 1 for splits)

effective_date    = when the corporate action takes effect at the exchange
availability_date = when we could have known about it (announcement date + processing)
```

**Critical invariant:** A future corporate action must NOT alter the adjusted price
available to a model prediction before `availability_date`.

If adjustment data is unavailable:
- Return `AdjustmentStatus.DATA_UNAVAILABLE`
- Return raw price only
- Log the limitation explicitly
- Do NOT silently use an unadjusted price and call it adjusted

---

## 6. Module Structure

```
ml-service/src/data/
├── __init__.py
├── point_in_time.py      — PointInTimeRecord, PointInTimeValidator
├── lineage.py            — MLObservationLineage, DatasetLineage
├── dataset_version.py    — DatasetSnapshot, DatasetVersionRegistry
├── instrument_master.py  — HistoricalInstrumentRecord, InstrumentMasterStore
├── historical_universe.py — UniverseMembership, HistoricalUniverse
├── corporate_actions.py  — CorporateActionRecord, CorporateActionStore
├── fno_eligibility.py    — FnOEligibilityRecord, FnOBanRecord, FnOStateStore
└── data_quality.py       — MLDataQualityIssue, MLDataQualityGate
```

---

## 7. Integration into data_pipeline.py

Seven-step pre-feature validation (added before `compute_stock_features()`):

```
Step 1: Validate timestamps (no naive, no future available_time)
Step 2: Validate instrument identity (symbol exists in instrument master at date)
Step 3: Resolve historical universe (is symbol MODEL_ELIGIBLE at date?)
Step 4: Resolve contract metadata (lot size at date, not today's lot size)
Step 5: Resolve corporate action state (raw vs adjusted price status)
Step 6: Resolve provider lineage (record observation_id)
Step 7: Run ML data quality gate (INVALID/STALE checks → CRITICAL blocks)
```

If any Step produces CRITICAL severity → observation is excluded from training.
If Step produces WARNING → observation is included but flagged in metadata.

---

## 8. Known Limitations (DATA_UNAVAILABLE policy)

The following historical data does NOT exist in any AlphaForge system today:

| Data | Status | Policy |
|---|---|---|
| Historical F&O eligibility per date | DATA_UNAVAILABLE | Return DATA_UNAVAILABLE; use current list with WARNING |
| Historical MWPL ban list per date | DATA_UNAVAILABLE | Return DATA_UNAVAILABLE; conservatively exclude from production |
| Historical corporate action adjustments | DATA_UNAVAILABLE | Return raw price; flag as UNADJUSTED |
| Historical lot-size changes | PARTIAL (known after SEBI Nov 2024) | Use best-known lookup table with effective dates |
| ISIN-based symbol continuity | DATA_UNAVAILABLE | Use symbol-based matching with WARNING |

**These limitations will be documented in every DatasetSnapshot created by this phase.**
No fabricated data will be substituted.

---

## 9. Backward Compatibility

- All existing `/predict/*` API endpoints: **unchanged**
- `market_data_client.py` OHLCVRecord / DerivativesSnapshot: extended with new fields but old fields preserved
- `data_pipeline.py` existing builder functions: unchanged in output; the 7-step validation wraps them
- `LOT_SIZES` dict: kept as fallback; new `InstrumentMasterStore.get_lot_size(symbol, date)` is the primary API
- `TRAINING_UNIVERSE`: kept as fallback; new `HistoricalUniverse.get_model_eligible(date)` is the primary API
