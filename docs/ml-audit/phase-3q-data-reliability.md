# Phase 3Q — Data-Reliability Layer (ML Audit)

**Scope:** Production Indian-market data-reliability layer for `ml-service`.
**Nature:** ADDITIVE package `ml-service/src/data_reliability/` reusing the existing
foundation (`paper.providers`, `paper.data_quality`, `data.point_in_time`,
`data.instrument_master`, `data.corporate_actions`, `data.historical_universe`,
`data.dataset_version`, `data.lineage`, `execution.market_calendar`,
`lifecycle._storage`). No model, feature, strategy, live-order, or
parameter-optimization change.

This document explains what the layer guarantees and — importantly — **documents
every approximation** so the guarantees are not overstated.

## Provider hierarchy & typed failures

- Deterministic hierarchy: **DataService → AngelOne → Upstox → Yahoo**
  (`paper.providers.PROVIDER_HIERARCHY`, reused).
- `failure.ProviderFailure` is the exhaustive taxonomy:
  `OK / NO_DATA / PROVIDER_FAILURE / DATA_INVALID / DATA_STALE / MARKET_CLOSED /
  SYMBOL_NOT_SUPPORTED / AUTH_FAILURE / RATE_LIMITED / NETWORK_FAILURE /
  UNKNOWN_PROVIDER_ERROR`.
- **`NO_DATA` ≠ `PROVIDER_FAILURE`.** A meaningful empty answer is not a failure and
  is **not** fallback-eligible. `MARKET_CLOSED` and `SYMBOL_NOT_SUPPORTED` are also
  not fallback-eligible. Any unrecognised failure fails **closed** to eligible.
- Failures are never silently swallowed — every path returns a typed state.

## Provider consistency → PROVIDER_CONFLICT

- `consistency.check_provider_consistency` wraps the existing
  `cross_provider_compare`. A strict mismatch OR any tolerant-tolerance breach →
  `PROVIDER_CONFLICT`. The result **never selects a "favourable" provider** — it
  only reports the conflict; the DQ gate then blocks consumption.

## Stale detection

- `stale.assess_staleness` combines age (delayed/future/missing via the existing
  `classify_freshness`), **frozen feed** (N identical consecutive OHLCV bars), and
  **timestamp regression**. Precedence (fail-closed): future > regression > frozen >
  delayed/missing > fresh.
- When the market is **closed**, age-based staleness is suppressed (a quiet feed is
  expected), but structural problems (frozen / regression) are still raised.

## Calendar & timezone integrity

- All timestamps are `Asia/Kolkata`-aware (`calendar_ext.IST`). Naive timestamps are
  rejected (`NAIVE_TIMESTAMP`).
- `is_valid_market_bar` classifies: weekend/holiday → `NON_TRADING_DAY`;
  outside 09:15–15:30 → `OUTSIDE_REGULAR_SESSION` (15:30 is the close boundary and is
  **not** inside the open session); uncovered calendar dates →
  `CALENDAR_INSUFFICIENT_EVIDENCE`.
- `prev_trading_session` walks backward over the existing `NSECalendar.is_trading_day`.

## Bar completeness — FORMING vs CLOSED

- `completeness.classify_last_bar_state`: a bar is `CLOSED_BAR` iff
  `now >= bar_start + interval`, else `FORMING_BAR`. The signal-safety gate treats a
  forming last bar as **not complete** → no signal.

## OHLC sanity (no silent repair)

- `ohlc_repair.sanitize_bars` quarantines any bar failing OHLC invariants
  (`high ≥ max(open,close)`, `low ≤ min(open,close)`, `high ≥ low`, positive finite
  prices, non-negative volume). The **original bar is preserved** in a `RepairRecord`;
  nothing is silently corrected or dropped. Default action is `QUARANTINE`.

## Corporate-action adjustment mode

- `adjustment.AdjustmentMode`: `RAW / SPLIT_ADJUSTED / TOTAL_RETURN_ADJUSTED /
  UNKNOWN`. `assert_same_mode` raises if series of different modes are combined, or if
  any series is `UNKNOWN` (fail-closed). Returns are never computed across mixed
  adjustment bases.

## Instrument-master identity & F&O PIT

- `data.instrument_master.get_lot_size` returns a **3-tuple** `(lot, status, source)`.
- **P3Q-001 (fixed):** `paper.data_quality.validate_fno_metadata` previously unpacked
  that 3-tuple into two targets, raising `ValueError`, whose `except` branch always
  emitted `FNO_LOT_SIZE_UNAVAILABLE` — so a wrong historical lot size was never
  detected as a mismatch. Fixed with a tolerant unpack. A historical lot that cannot
  be established point-in-time is reported `DATA_INSUFFICIENT`; today's lot is never
  fabricated onto a historical date.

## Historical universe PIT

- Universe eligibility is resolved point-in-time via the existing
  `reject_future_universe_membership` / `HistoricalUniverse`; current constituents are
  never silently applied to historical dates (survivorship-bias guard).

## DataQualityGate (fail-closed)

- `quality_gate.evaluate_data_quality` aggregates OHLCV validity, staleness,
  completeness, cross-provider consistency, and sanitisation into a single
  `DQVerdict`. Worst-wins precedence:
  `VALID < VALID_WITH_WARNINGS < INSUFFICIENT_EVIDENCE < UNAVAILABLE < INCOMPLETE <
  STALE < CONFLICT < INVALID`. Only `VALID` / `VALID_WITH_WARNINGS` are
  `safe_to_consume`. Invalid data cannot reach feature → model → signal.

## Feature availability (no silent 0.0)

- `feature_availability.FeatureValue` carries an availability tag
  (`AVAILABLE / TRUE_ZERO / MISSING / NOT_APPLICABLE / NOT_YET_AVAILABLE /
  DATA_INSUFFICIENT`). `.resolved()` returns `0.0` **only** for `TRUE_ZERO`, the value
  for `AVAILABLE`, and **None** otherwise — missing data is never substituted with a
  neutral default.

## Signal safety (10-gate → NO_DECISION)

- `signal_safety.evaluate_signal_safety` requires all ten gates
  (market-ts valid / bars complete / features available / DQ passed / model valid /
  model-calibrator compatible / probability semantics valid / decision provenance
  exists / no future info / provider status acceptable). Any failure → `NO_DECISION`
  with a typed reason. It returns **only** `PROCEED` / `NO_DECISION` — never a
  directional BUY/SELL. A missing gate is treated as failed (fail-closed).

## Cache / lineage / snapshot / replay / correction

- `cache.CacheStore` only returns a `HIT` when provider, schema, adjustment mode, and
  dataset version match and the TTL is unexpired; a stale entry can never override a
  fresh one, and it never weakens PIT.
- `lineage_ext.record_lineage` extends the existing lineage store with 3Q provenance
  (fallback reason, source priority, validation status, adjustment mode,
  transformation version).
- `snapshot.SnapshotIdentity` fingerprints provider set (order-independent) + universe
  + date range + schema + transformation + CA version + feature version.
- `replay.ReplayDriver.replay(as_of)` returns only records available at `as_of`
  (reuses `PointInTimeRecord.is_available_at` + `select_best_revision`); future bars /
  corrections leak nothing.
- `correction.CorrectionLog` is append-only: `ORIGINAL` is preserved and `CORRECTED`
  revisions are appended with a higher `revision_id`.

## Documented approximations & limitations

1. **Muhurat sessions** are an **explicit hardcoded set** (2023-11-12, 2024-11-01,
   2025-10-21). New years must be added manually; unknown dates are treated as
   non-Muhurat.
2. **Retry backoff performs no real sleep by default** — the schedule is deterministic
   and the caller injects any real wait. This keeps tests fast and avoids storms; a
   production caller must supply a real `sleep`.
3. The **current-day harness is synthetic / paper-shadow only.** It composes 3Q
   assessments into a read-only report and never places an order.
4. **Real-provider / real-market validation is NOT exercised** in this environment:
   there are no live broker credentials, and `talib/torch/sklearn/riskfolio/yfinance`
   are absent. All 3Q tests run on sanitized synthetic fixtures.
5. The **double-counting audit is document-only** — it records overlaps between signal
   families; it removes nothing and re-weights nothing.
