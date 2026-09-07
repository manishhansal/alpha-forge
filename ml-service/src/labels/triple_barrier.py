"""
Triple-Barrier Labels — Label V2.

Implements path-dependent, event-based labeling for Indian equity/F&O.

The three barriers
------------------
Upper barrier (TP):  entry × (1 + upper_pct/100) for LONG
                     entry × (1 - upper_pct/100) for SHORT
Lower barrier (SL):  entry × (1 - lower_pct/100) for LONG
                     entry × (1 + lower_pct/100) for SHORT
Vertical barrier:    event_start + horizon_bars (time limit)

First-touch semantics
---------------------
We scan the OHLCV forward bar-by-bar and find the FIRST bar where
a barrier is touched.  This is NOT .any() over the full window —
it is a sequential scan.

Intrabar ambiguity
------------------
When a single OHLC bar has both a TP high ≥ upper_barrier AND
a SL low ≤ lower_barrier, OHLC data alone cannot determine which
was hit first.  Policy (configurable):
  "CONSERVATIVE_SL"  → call it STOP_LOSS (worst case for the trader)
  "DATA_AMBIGUOUS"   → mark as INTRABAR_AMBIGUOUS, exclude from training

Long / Short semantics
----------------------
For LONG:
  TP at high >= upper_barrier
  SL at low  <= lower_barrier
For SHORT:
  TP at low  <= upper_barrier  (price fell enough for short to profit)
  SL at high >= lower_barrier  (price rose enough to hit short stop)

Incomplete horizons
-------------------
If the dataset ends before the vertical barrier, the event is marked
is_incomplete=True and first_touch=DATA_INSUFFICIENT.
These events are EXCLUDED from supervised training.

Do NOT reclassify them as TIME_LIMIT.

Expiry-awareness
----------------
The event window is capped at contract_expiry when provided.
Events cannot continue past the tradable life of the instrument.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
import structlog

from .config import LabelConfig
from .schemas import (
    FirstTouch, LabelDiagnostics, LabelFamily, PriceBasis,
    RiskOutcomeLabel, Side, TripleBarrierLabel,
)

logger = structlog.get_logger(__name__)

UTC = timezone.utc


# ── ATR volatility for barrier sizing ────────────────────────────────────────

def _compute_atr_at_bar(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    i: int,
    window: int,
) -> float:
    """Return ATR at bar i as a fraction of close price (trailing, not forward)."""
    start = max(0, i - window)
    h = high.iloc[start:i + 1]
    l = low.iloc[start:i + 1]
    c = close.iloc[start:i + 1]
    if len(c) < 2:
        # Not enough bars for a true ATR — fall back to a 1% default fraction.
        # Do NOT return close*0.01 (that would give a 100× too-large fraction for
        # prices like 100).
        return 0.01

    c_prev = c.shift(1)
    tr = pd.concat([h - l, (h - c_prev).abs(), (l - c_prev).abs()], axis=1).max(axis=1)
    # Drop the first row where c_prev is NaN → TR = h-l only, which is fine for the first bar
    tr_valid = tr.dropna()
    atr_abs = float(tr_valid.mean()) if len(tr_valid) > 0 else float((h - l).mean())
    close_val = float(c.iloc[-1])
    # Return ATR as a FRACTION of close price (not absolute)
    return atr_abs / close_val if close_val > 0 else 0.01


# ── Core triple-barrier engine ────────────────────────────────────────────────

def generate_triple_barrier_labels(
    ohlcv: pd.DataFrame,
    config: Optional[LabelConfig] = None,
    symbol: str = "UNKNOWN",
    side: Side = Side.LONG,
    price_basis: PriceBasis = PriceBasis.RAW,
    contract_expiry: Optional[datetime] = None,
) -> list[TripleBarrierLabel]:
    """
    Generate triple-barrier event labels for all valid bars.

    For each bar i (the entry bar):
      1. Compute volatility from bars [i-vol_window .. i] (trailing only).
      2. Set barriers: upper = entry*(1 + atr*pt_mult), lower = entry*(1 - atr*sl_mult).
      3. Scan forward bars [i+1 .. i+horizon] bar-by-bar to find first barrier touch.
      4. Record first_touch, barrier_hit_time, gross_return.

    Parameters
    ----------
    ohlcv           : DataFrame [open, high, low, close, volume], UTC index.
    config          : LabelConfig (defaults to default_daily()).
    symbol          : For provenance.
    side            : LONG or SHORT.
    price_basis     : RAW or ADJUSTED.
    contract_expiry : Optional hard stop for event window.

    Returns
    -------
    list[TripleBarrierLabel] — one per valid entry bar.
    Tail entries (insufficient forward window) are DATA_INSUFFICIENT.
    """
    if config is None:
        config = LabelConfig.default_daily()

    cfg_hash   = config.hash
    horizon    = config.vertical_barrier_bars if hasattr(config, "vertical_barrier_bars") \
                 else config.horizon_bars
    pt_mult    = config.pt_multiplier
    sl_mult    = config.sl_multiplier
    vol_window = config.volatility_window
    min_vol    = config.min_volatility
    amb_policy = config.ambiguity_policy

    ohlcv = ohlcv.copy()
    close = ohlcv["close"].astype(float)
    high  = ohlcv["high"].astype(float)
    low   = ohlcv["low"].astype(float)
    n     = len(ohlcv)
    idx   = ohlcv.index

    if isinstance(idx, pd.DatetimeIndex) and idx.tz is None:
        raise ValueError(
            f"ohlcv index for {symbol} has no timezone. Use tz_localize('UTC')."
        )

    events: list[TripleBarrierLabel] = []

    for i in range(n):
        t0        = idx[i]
        entry_prc = float(close.iloc[i])

        if not np.isfinite(entry_prc) or entry_prc <= 0:
            continue

        # ── Skip entry bars that are at or after contract expiry ──────────
        if contract_expiry is not None:
            t0_dt = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
            if t0_dt >= contract_expiry:
                continue

        # ── Volatility: trailing window only (no future look) ─────────────
        atr_frac = _compute_atr_at_bar(high, low, close, i, vol_window)
        atr_frac = max(atr_frac, min_vol)

        # ── Barriers as % of entry ─────────────────────────────────────────
        upper_pct = pt_mult * atr_frac * 100   # e.g. 1.5 * 1% = 1.5%
        lower_pct = sl_mult * atr_frac * 100   # e.g. 1.0 * 1% = 1.0%

        if side == Side.LONG:
            tp_price = entry_prc * (1.0 + upper_pct / 100.0)
            sl_price = entry_prc * (1.0 - lower_pct / 100.0)
        else:  # SHORT
            tp_price = entry_prc * (1.0 - upper_pct / 100.0)
            sl_price = entry_prc * (1.0 + lower_pct / 100.0)

        # ── Scan forward bars [i+1 .. i+horizon] ──────────────────────────
        scan_end = min(i + horizon, n - 1)
        is_incomplete = (i + horizon) >= n

        first_touch      = FirstTouch.DATA_INSUFFICIENT
        barrier_hit_time = None
        exit_price       = None
        intrabar_amb     = False
        event_end_bar    = scan_end

        if is_incomplete:
            # Not enough future bars — DATA_INSUFFICIENT; don't scan.
            # Still respect contract_expiry to cap event_end_bar.
            first_touch   = FirstTouch.DATA_INSUFFICIENT
            exit_price    = float(close.iloc[-1])
            event_end_bar = n - 1
            if contract_expiry is not None:
                for ei in range(i, n):
                    bt_ei = idx[ei]
                    bt_dt = bt_ei.to_pydatetime() if hasattr(bt_ei, "to_pydatetime") else bt_ei
                    if bt_dt > contract_expiry:
                        event_end_bar = max(i, ei - 1)
                        break
        else:
            for j in range(i + 1, scan_end + 1):
                bar_high  = float(high.iloc[j])
                bar_low   = float(low.iloc[j])
                bar_close = float(close.iloc[j])
                bar_time  = idx[j]

                # Respect contract expiry
                if contract_expiry is not None:
                    bt = bar_time.to_pydatetime() if hasattr(bar_time, "to_pydatetime") else bar_time
                    if bt > contract_expiry:
                        first_touch   = FirstTouch.DATA_INSUFFICIENT
                        event_end_bar = j - 1
                        is_incomplete = True
                        break

                if side == Side.LONG:
                    tp_hit = bar_high >= tp_price
                    sl_hit = bar_low  <= sl_price
                else:  # SHORT
                    tp_hit = bar_low  <= tp_price
                    sl_hit = bar_high >= sl_price

                if tp_hit and sl_hit:
                    # ── Intrabar ambiguity ───────────────────────────────
                    intrabar_amb = True
                    if amb_policy == "CONSERVATIVE_SL":
                        first_touch      = FirstTouch.STOP_LOSS
                        barrier_hit_time = bar_time.to_pydatetime() \
                            if hasattr(bar_time, "to_pydatetime") else bar_time
                        exit_price       = float(sl_price)
                    else:
                        first_touch      = FirstTouch.INTRABAR_AMBIGUOUS
                        barrier_hit_time = bar_time.to_pydatetime() \
                            if hasattr(bar_time, "to_pydatetime") else bar_time
                        exit_price       = bar_close
                    event_end_bar = j
                    break

                elif tp_hit:
                    first_touch      = FirstTouch.TAKE_PROFIT
                    barrier_hit_time = bar_time.to_pydatetime() \
                        if hasattr(bar_time, "to_pydatetime") else bar_time
                    exit_price       = float(tp_price)
                    event_end_bar    = j
                    break

                elif sl_hit:
                    first_touch      = FirstTouch.STOP_LOSS
                    barrier_hit_time = bar_time.to_pydatetime() \
                        if hasattr(bar_time, "to_pydatetime") else bar_time
                    exit_price       = float(sl_price)
                    event_end_bar    = j
                    break

            else:
                # Loop completed without hitting any barrier → TIME_LIMIT
                first_touch   = FirstTouch.TIME_LIMIT
                exit_price    = float(close.iloc[scan_end])
                event_end_bar = scan_end

        # ── Gross return ───────────────────────────────────────────────────
        gross_return: Optional[float] = None
        if exit_price is not None and not is_incomplete:
            raw_ret = (exit_price - entry_prc) / entry_prc
            gross_return = float(side.value) * raw_ret

        # ── Net return (if cost model is applied) ─────────────────────────
        net_return: Optional[float] = None
        cost_status = "DATA_UNAVAILABLE"
        if (
            config.include_costs
            and gross_return is not None
            and config.cost_model.version != "DATA_UNAVAILABLE"
        ):
            rtt = config.cost_model.round_trip_cost_pct / 100.0
            net_return = gross_return - rtt
            cost_status = "APPLIED"

        # ── Build timestamps ───────────────────────────────────────────────
        t0_dt = t0.to_pydatetime() if hasattr(t0, "to_pydatetime") else t0
        t1_ts = idx[event_end_bar]
        t1_dt = t1_ts.to_pydatetime() if hasattr(t1_ts, "to_pydatetime") else t1_ts

        events.append(TripleBarrierLabel(
            symbol=symbol,
            event_start_time=t0_dt,
            event_end_time=t1_dt,
            label_available_time=t1_dt,
            label_family=LabelFamily.TRIPLE_BARRIER,
            label_version=config.version,
            label_config_hash=cfg_hash,
            side=side,
            price_basis=price_basis,
            bar_frequency=config.bar_frequency,
            upper_barrier_pct=upper_pct,
            lower_barrier_pct=lower_pct,
            vertical_barrier_bars=horizon,
            volatility_reference=atr_frac,
            entry_price=entry_prc,
            exit_price=exit_price,
            first_touch=first_touch,
            barrier_hit_time=barrier_hit_time,
            gross_return=gross_return,
            net_return=net_return,
            cost_status=cost_status,
            intrabar_ambiguous=intrabar_amb,
            ambiguity_policy=amb_policy,
            is_incomplete=is_incomplete,
        ))

    return events


# ── Backward-compat adapter: returns (y_stop, y_target, y_mae) arrays ─────────

def generate_risk_labels_v2(
    df: pd.DataFrame,
    atr_series: pd.Series,
    stop_atr_mult: float = 1.4,
    target_atr_mult: float = 2.0,
    lookforward: int = 20,
    ambiguity_policy: str = "CONSERVATIVE_SL",
    symbol: str = "UNKNOWN",
) -> tuple[pd.Series, pd.Series, pd.Series, list[TripleBarrierLabel]]:
    """
    Replacement for legacy generate_risk_labels().

    FIXES from lv1:
      ✓ First-touch semantics (sequential scan, not .any() over full window)
      ✓ Simultaneous TP+SL resolved per ambiguity_policy (no silent TP assumption)
      ✓ is_incomplete=True → DATA_INSUFFICIENT, not TIME_LIMIT
      ✓ event_start_time / event_end_time populated
      ✓ Long-only (short support available via config)

    Returns
    -------
    (y_stop, y_target, y_mae, label_events)
    y_stop, y_target, y_mae: pd.Series aligned to df.index (backward compat)
    label_events: full TripleBarrierLabel list for provenance
    """
    config = LabelConfig(
        version="lv2",
        horizon_bars=lookforward,
        pt_multiplier=target_atr_mult,
        sl_multiplier=stop_atr_mult,
        volatility_window=20,
        volatility_type="ATR",
        ambiguity_policy=ambiguity_policy,
        bar_frequency="1D",
    )

    # Use pre-computed ATR series for backward compat
    # (rather than computing inside triple_barrier with rolling)
    n = len(df)
    close = df["close"].astype(float)
    high  = df["high"].astype(float)
    low   = df["low"].astype(float)
    idx   = df.index

    y_stop   = pd.Series(np.nan, index=idx, dtype=float)
    y_target = pd.Series(np.nan, index=idx, dtype=float)
    y_mae    = pd.Series(np.nan, index=idx, dtype=float)
    events:  list[TripleBarrierLabel] = []

    for i in range(n - lookforward):
        entry = float(close.iloc[i])
        atr_v = float(atr_series.iloc[i]) if i < len(atr_series) else np.nan
        if not np.isfinite(entry) or entry <= 0:
            continue
        if not np.isfinite(atr_v) or atr_v <= 0:
            continue

        tp_price = entry + target_atr_mult * atr_v
        sl_price = entry - stop_atr_mult * atr_v
        upper_pct = (tp_price - entry) / entry * 100
        lower_pct = (entry - sl_price) / entry * 100

        first_touch      = FirstTouch.TIME_LIMIT
        barrier_hit_time = None
        exit_price       = float(close.iloc[i + lookforward])
        event_end_bar    = i + lookforward
        intrabar_amb     = False
        adverse_excursion: Optional[float] = None

        # Sequential bar scan
        for j in range(i + 1, i + lookforward + 1):
            bar_high = float(high.iloc[j])
            bar_low  = float(low.iloc[j])
            tp_hit   = bar_high >= tp_price
            sl_hit   = bar_low  <= sl_price

            if tp_hit and sl_hit:
                intrabar_amb = True
                if ambiguity_policy == "CONSERVATIVE_SL":
                    first_touch      = FirstTouch.STOP_LOSS
                    barrier_hit_time = idx[j]
                    exit_price       = sl_price
                else:
                    first_touch      = FirstTouch.INTRABAR_AMBIGUOUS
                    barrier_hit_time = idx[j]
                    exit_price       = float(close.iloc[j])
                event_end_bar = j
                break
            elif tp_hit:
                first_touch      = FirstTouch.TAKE_PROFIT
                barrier_hit_time = idx[j]
                exit_price       = tp_price
                event_end_bar    = j
                break
            elif sl_hit:
                first_touch      = FirstTouch.STOP_LOSS
                barrier_hit_time = idx[j]
                exit_price       = sl_price
                event_end_bar    = j
                break

        # Backward-compat binary labels
        stop_hit_val   = 1.0 if first_touch == FirstTouch.STOP_LOSS else 0.0
        target_hit_val = 1.0 if first_touch == FirstTouch.TAKE_PROFIT else 0.0

        # MAE: worst intraday excursion during event window
        fwd_lows = low.iloc[i + 1 : event_end_bar + 1]
        if len(fwd_lows) > 0:
            min_low = float(fwd_lows.min())
            raw_mae = abs(min((min_low - entry) / entry * 100, 0.0))
            adverse_excursion = min(raw_mae, 20.0)

        y_stop.iloc[i]   = stop_hit_val
        y_target.iloc[i] = target_hit_val
        y_mae.iloc[i]    = adverse_excursion if adverse_excursion is not None else np.nan

        t0_dt = idx[i].to_pydatetime() if hasattr(idx[i], "to_pydatetime") else idx[i]
        t1_ts = idx[event_end_bar]
        t1_dt = t1_ts.to_pydatetime() if hasattr(t1_ts, "to_pydatetime") else t1_ts

        gross_ret = (exit_price - entry) / entry
        events.append(TripleBarrierLabel(
            symbol=symbol,
            event_start_time=t0_dt,
            event_end_time=t1_dt,
            label_available_time=t1_dt,
            label_family=LabelFamily.TRIPLE_BARRIER,
            label_version="lv2",
            label_config_hash=config.hash,
            side=Side.LONG,
            price_basis=PriceBasis.RAW,
            bar_frequency="1D",
            upper_barrier_pct=upper_pct,
            lower_barrier_pct=lower_pct,
            vertical_barrier_bars=lookforward,
            volatility_reference=atr_v / entry,
            entry_price=entry,
            exit_price=exit_price,
            first_touch=first_touch,
            barrier_hit_time=(
                barrier_hit_time.to_pydatetime()
                if hasattr(barrier_hit_time, "to_pydatetime") and barrier_hit_time is not None
                else barrier_hit_time
            ),
            gross_return=gross_ret,
            intrabar_ambiguous=intrabar_amb,
            ambiguity_policy=ambiguity_policy,
            is_incomplete=False,
        ))

    return y_stop, y_target, y_mae, events


# ── Label diagnostics ─────────────────────────────────────────────────────────

def label_diagnostics_triple(
    events: list[TripleBarrierLabel],
    config: LabelConfig,
) -> LabelDiagnostics:
    valid = [e for e in events if not e.is_incomplete
             and e.first_touch not in (FirstTouch.DATA_INSUFFICIENT, FirstTouch.DATA_MISSING)]

    diag = LabelDiagnostics(
        label_family=LabelFamily.TRIPLE_BARRIER.value,
        label_version=config.version,
        label_config_hash=config.hash,
        sample_count=len(events),
        incomplete_count=sum(1 for e in events if e.is_incomplete),
        ambiguous_count=sum(1 for e in events if e.intrabar_ambiguous),
        tp_count=sum(1 for e in valid if e.first_touch == FirstTouch.TAKE_PROFIT),
        sl_count=sum(1 for e in valid if e.first_touch == FirstTouch.STOP_LOSS),
        time_count=sum(1 for e in valid if e.first_touch == FirstTouch.TIME_LIMIT),
    )

    returns = [e.gross_return for e in valid if e.gross_return is not None]
    if returns:
        arr = np.array(returns)
        diag.positive_count    = int((arr > 0).sum())
        diag.negative_count    = int((arr < 0).sum())
        diag.neutral_count     = int((arr == 0).sum())
        diag.mean_gross_return   = round(float(np.mean(arr)), 6)
        diag.median_gross_return = round(float(np.median(arr)), 6)
        diag.std_gross_return    = round(float(np.std(arr)), 6)

    return diag
