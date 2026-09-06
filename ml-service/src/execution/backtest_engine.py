"""
Phase 3G — Event-Driven Backtest Engine.

Converts frozen Phase 3F OOS outputs into simulated trade results.

Core rules (spec §3, §22, §33)
-------------------------------
1. OOS INPUTS ONLY: the engine NEVER retrains models, refits calibration,
   or optimises thresholds. It accepts frozen prediction records.
2. DETERMINISTIC: same inputs + same provenance → identical results.
3. NO SAME-BAR LOOKAHEAD: signals from close(T) execute at T+1 by default.
4. NO FAKE FILLS: if execution data is unavailable, returns UNAVAILABLE.

Pipeline (spec §1)
------------------
    OOS decision record
        ↓ FillEngine
    SimulatedFill (entry)
        ↓ TradeAccountingLedger
    Position
        ↓ exit via stop/target/time-limit
    SimulatedFill (exit)
        ↓ TradeAccountingLedger
    TradeRecord (with full cost breakdown)
        ↓
    ExecutionLedger → BacktestResult
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional

import numpy as np

from .cost_model import CostScheduleRegistry, DEFAULT_REGISTRY
from .fill_engine import FillEngine, FillEngineConfig, OHLCBar
from .market_calendar import NSECalendar, DEFAULT_CALENDAR
from .position_accounting import PortfolioState, TradeAccountingLedger, TurnoverStats
from .schemas import (
    AmbiguityPolicy, CostBreakdown, ExecutionDataLevel, ExecutionLedger,
    ExecutionPolicy, FillStatus, InstrumentType, OrderIntent,
    OrderSide, ProductType, SimulatedFill, SpreadDataStatus,
    TradeSide, TradeRecord, make_order_id,
)

UTC = timezone.utc


# ── OOS decision record (input to the backtest engine) ────────────────────────

@dataclass
class OOSDecisionRecord:
    """
    A frozen OOS prediction record from Phase 3F.

    The backtest engine consumes these and simulates execution.
    It must NEVER modify prediction values.
    """
    instrument_id:       str
    signal_time:         datetime         # when signal was generated
    trade_side:          TradeSide
    alpha_score:         Optional[float]
    meta_probability:    Optional[float]  # CalibratedProbability.value
    expected_value:      Optional[float]
    decision:            str              # TAKE / SKIP / ABSTAIN
    horizon_bars:        int              # target holding period
    entry_price_hint:    Optional[float]  # close at signal time (reference)
    stop_price_hint:     Optional[float]  # suggested stop (from risk model)
    target_price_hint:   Optional[float]  # suggested target

    # Provenance — must be frozen; backtest records these verbatim
    model_id:            str = ""
    model_version:       str = ""
    meta_model_id:       str = ""
    calibrator_id:       str = ""
    feature_set_id:      str = ""
    label_version:       str = "lv2"
    dataset_id:          str = ""
    lot_size:            int = 1          # from InstrumentMasterStore PIT lookup
    instrument_type:     InstrumentType = InstrumentType.FUT_IDX
    product_type:        ProductType    = ProductType.NRML
    expiry_date:         Optional[datetime] = None


# ── Backtest configuration ─────────────────────────────────────────────────────

@dataclass
class BacktestConfig:
    """
    Versioned configuration for one backtest run.

    Changing ANY field produces a different backtest hash.
    """
    backtest_id:           str
    execution_policy:      ExecutionPolicy    = ExecutionPolicy.NEXT_OPEN
    ambiguity_policy:      AmbiguityPolicy    = AmbiguityPolicy.CONSERVATIVE
    slippage_bps:          float              = 5.0
    max_participation_pct: float              = 0.10
    initial_capital_inr:   float              = 1_000_000.0
    max_open_positions:    int                = 10
    random_seed:           int                = 42
    cost_schedule_version: str                = "india-fno-2023"
    slippage_model_version: str               = "spread_proxy-k0.3-slippage-v1"
    instrument_metadata_version: str          = "best-known-v1"
    execution_engine_version: str             = "backtest-engine-v1"

    @property
    def config_hash(self) -> str:
        """Deterministic 16-char hash of the configuration."""
        # Coerce string → enum (allows BacktestConfig(execution_policy="NEXT_OPEN"))
        exec_pol = self.execution_policy
        if isinstance(exec_pol, str):
            exec_pol = ExecutionPolicy(exec_pol)
        amb_pol = self.ambiguity_policy
        if isinstance(amb_pol, str):
            amb_pol = AmbiguityPolicy(amb_pol)
        key = {
            "exec_policy":    exec_pol.value,
            "ambiguity":      amb_pol.value,
            "slippage_bps":   self.slippage_bps,
            "participation":  self.max_participation_pct,
            "capital":        self.initial_capital_inr,
            "max_pos":        self.max_open_positions,
            "seed":           self.random_seed,
            "cost_sched":     self.cost_schedule_version,
            "slip_model":     self.slippage_model_version,
            "inst_meta":      self.instrument_metadata_version,
            "engine":         self.execution_engine_version,
        }
        raw = json.dumps(key, sort_keys=True)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ── Backtest provenance ───────────────────────────────────────────────────────

@dataclass
class BacktestProvenance:
    """
    Complete reproducibility record for a backtest run.
    Same provenance → identical results (spec §33).
    """
    backtest_id:          str
    config_hash:          str
    git_commit:           str
    dataset_id:           str
    universe_version:     str
    feature_set_id:       str
    label_version:        str
    primary_model_id:     str
    meta_model_id:        str
    calibrator_id:        str
    cost_schedule_version: str
    slippage_model_version: str
    instrument_metadata_version: str
    execution_engine_version: str
    n_oos_decisions:      int
    run_timestamp:        datetime
    notes:                str = ""


# ── Backtest result ───────────────────────────────────────────────────────────

@dataclass
class BacktestResult:
    """Full result of one backtest run."""
    provenance:           BacktestProvenance
    ledger:               ExecutionLedger
    turnover:             TurnoverStats
    final_cash_inr:       float
    initial_capital_inr:  float

    # Performance summary
    total_gross_pnl:      float = 0.0
    total_cost:           float = 0.0
    total_net_pnl:        float = 0.0
    n_trades:             int   = 0
    n_wins:               int   = 0
    n_losses:             int   = 0
    win_rate:             Optional[float] = None
    avg_net_return_pct:   Optional[float] = None
    max_drawdown_inr:     Optional[float] = None
    gross_turnover_inr:   float = 0.0
    cost_to_gross_ratio:  Optional[float] = None

    # Evidence and limitations
    execution_data_level: ExecutionDataLevel = ExecutionDataLevel.C
    n_rejected_orders:    int = 0
    n_unavailable_fills:  int = 0
    n_partial_fills:      int = 0
    notes:                str = ""

    def pnl_reconciled(self) -> bool:
        return self.ledger.verify_cost_reconciliation()

    def to_dict(self) -> dict:
        return {
            "backtest_id":       self.provenance.backtest_id,
            "config_hash":       self.provenance.config_hash,
            "n_trades":          self.n_trades,
            "total_gross_pnl":   round(self.total_gross_pnl, 2),
            "total_cost":        round(self.total_cost, 2),
            "total_net_pnl":     round(self.total_net_pnl, 2),
            "win_rate":          round(self.win_rate or 0.0, 4),
            "gross_turnover_inr": round(self.gross_turnover_inr, 2),
            "cost_to_gross":     self.cost_to_gross_ratio,
            "pnl_reconciled":    self.pnl_reconciled(),
            "n_rejected":        self.n_rejected_orders,
            "n_unavailable":     self.n_unavailable_fills,
            "execution_evidence": self.execution_data_level.value,
        }


# ── Backtest engine ───────────────────────────────────────────────────────────

class BacktestEngine:
    """
    Event-driven backtesting engine.

    Processes a list of OOSDecisionRecord objects against historical
    OHLCV price data and produces a BacktestResult.

    No model retraining occurs inside the engine.
    No calibration refitting occurs inside the engine.
    No threshold optimisation occurs inside the engine.
    Frozen OOS outputs are consumed verbatim.
    """

    def __init__(
        self,
        config:       Optional[BacktestConfig] = None,
        calendar:     Optional[NSECalendar] = None,
        cost_registry: Optional[CostScheduleRegistry] = None,
    ):
        self.config   = config or BacktestConfig(backtest_id="default")
        self.calendar = calendar or DEFAULT_CALENDAR
        self.cost_reg = cost_registry or DEFAULT_REGISTRY

        cfg = self.config
        fill_cfg = FillEngineConfig(
            default_policy=cfg.execution_policy,
            ambiguity_policy=cfg.ambiguity_policy,
            max_participation_pct=cfg.max_participation_pct,
            slippage_bps=cfg.slippage_bps,
        )
        self._fill_engine = FillEngine(config=fill_cfg, calendar=self.calendar)

    def run(
        self,
        decisions:      list[OOSDecisionRecord],
        price_data:     dict[str, list[OHLCBar]],   # symbol → sorted bars (asc)
        fno_ban_dates:  dict[str, set[date]] | None = None,
        git_commit:     str = "unknown",
    ) -> BacktestResult:
        """
        Run the backtest.

        Parameters
        ----------
        decisions    : Frozen OOS decision records from Phase 3F.
        price_data   : Historical OHLCV bars per symbol, sorted ascending.
        fno_ban_dates: {symbol: set of dates under F&O ban}.
        git_commit   : For provenance recording.

        Returns
        -------
        BacktestResult with full ExecutionLedger and performance summary.
        """
        cfg = self.config
        ledger_account = TradeAccountingLedger(
            initial_capital_inr=cfg.initial_capital_inr,
            backtest_id=cfg.backtest_id,
            cost_registry=self.cost_reg,
        )
        ban_dates = fno_ban_dates or {}

        n_rejected = n_unavailable = n_partial = 0

        # ── Process each TAKE decision ────────────────────────────────────────
        for rec in decisions:
            if rec.decision != "TAKE":
                continue

            sym   = rec.instrument_id
            bars  = price_data.get(sym, [])
            if not bars:
                n_unavailable += 1
                continue

            # Find the signal bar by timestamp
            signal_idx = self._find_bar_index(bars, rec.signal_time)
            if signal_idx is None:
                n_unavailable += 1
                continue

            signal_bar = bars[signal_idx]
            next_bars  = bars[signal_idx + 1:]

            if not next_bars:
                n_unavailable += 1
                continue

            # Check F&O ban
            trade_date = next_bars[0].timestamp.date()
            is_banned = trade_date in ban_dates.get(sym, set())

            # Build order intent
            order = OrderIntent(
                order_id=make_order_id(),
                instrument_id=sym,
                underlying=sym,
                instrument_type=rec.instrument_type,
                product_type=rec.product_type,
                side=rec.trade_side,
                order_side=OrderSide.BUY if rec.trade_side == TradeSide.LONG else OrderSide.SELL,
                quantity_lots=1,  # simple 1-lot per signal; extend for sizing
                lot_size=rec.lot_size,
                limit_price=None,
                stop_price=rec.stop_price_hint,
                signal_time=rec.signal_time,
                decision_time=rec.signal_time,
                order_time=rec.signal_time,
                execution_policy=cfg.execution_policy,
                model_id=rec.model_id,
                model_version=rec.model_version,
                dataset_id=rec.dataset_id,
                feature_set_id=rec.feature_set_id,
                label_version=rec.label_version,
                calibrator_id=rec.calibrator_id,
                meta_probability=rec.meta_probability,
                alpha_score=rec.alpha_score,
                expected_value=rec.expected_value,
                expiry_date=rec.expiry_date,
            )

            # Entry fill
            entry_fill = self._fill_engine.fill(
                order=order,
                signal_bar=signal_bar,
                next_bars=next_bars,
                fno_ban=is_banned,
                is_new_position=True,
            )

            if entry_fill.status == FillStatus.REJECTED:
                n_rejected += 1
                continue
            if entry_fill.status == FillStatus.UNAVAILABLE:
                n_unavailable += 1
                continue
            if entry_fill.status == FillStatus.PARTIAL:
                n_partial += 1

            if not entry_fill.filled:
                continue

            # Create position
            pos = ledger_account.open_position(
                entry_fill=entry_fill,
                instrument_type=rec.instrument_type,
                product_type=rec.product_type,
                lot_size=rec.lot_size,
                trade_date=trade_date,
                model_id=rec.model_id,
                model_version=rec.model_version,
            )
            if pos is None:
                continue

            # Find exit bar (horizon_bars forward from entry)
            entry_bar_idx = self._find_bar_index(bars, entry_fill.actual_fill_time or next_bars[0].timestamp)
            if entry_bar_idx is None:
                entry_bar_idx = signal_idx + 1

            exit_bars_remaining = bars[entry_bar_idx + 1:]
            holding_bars = 0
            exit_fill    = None
            exit_bar     = None

            # Scan forward for stop/target/time-limit
            for fwd_idx, fwd_bar in enumerate(exit_bars_remaining):
                holding_bars += 1
                if rec.stop_price_hint is not None or rec.target_price_hint is not None:
                    outcome = self._fill_engine.resolve_ambiguity(
                        bar=fwd_bar,
                        stop_price=rec.stop_price_hint or -1e9,
                        target_price=rec.target_price_hint or 1e9,
                        trade_side=rec.trade_side,
                    )
                    if outcome == "STOP" and rec.stop_price_hint is not None:
                        exit_bar   = fwd_bar
                        exit_price = rec.stop_price_hint
                        # Gap-through: if open is worse, use open
                        if rec.trade_side == TradeSide.LONG and fwd_bar.open < rec.stop_price_hint:
                            exit_price = fwd_bar.open
                        elif rec.trade_side == TradeSide.SHORT and fwd_bar.open > rec.stop_price_hint:
                            exit_price = fwd_bar.open
                        exit_fill = self._make_exit_fill(
                            entry_fill, fwd_bar, exit_price, rec.trade_side, "STOP_HIT"
                        )
                        break
                    elif outcome == "TARGET" and rec.target_price_hint is not None:
                        exit_bar   = fwd_bar
                        exit_price = rec.target_price_hint
                        exit_fill  = self._make_exit_fill(
                            entry_fill, fwd_bar, exit_price, rec.trade_side, "TARGET_HIT"
                        )
                        break
                    elif outcome == "UNKNOWN":
                        exit_bar  = fwd_bar
                        exit_fill = self._make_exit_fill(
                            entry_fill, fwd_bar, fwd_bar.close, rec.trade_side,
                            "AMBIGUOUS_BAR_CONSERVATIVE"
                        )
                        break

                if holding_bars >= rec.horizon_bars:
                    exit_bar  = fwd_bar
                    exit_fill = self._make_exit_fill(
                        entry_fill, fwd_bar, fwd_bar.close, rec.trade_side, "TIME_LIMIT"
                    )
                    break

            if exit_fill is None:
                # No exit found — skip (position remains open in ledger)
                continue

            exit_trade_date = (exit_fill.actual_fill_time or next_bars[0].timestamp).date()
            ledger_account.close_position(
                position=pos,
                exit_fill=exit_fill,
                trade_date=exit_trade_date,
                holding_bars=holding_bars,
                cost_model_version=cfg.cost_schedule_version,
            )

        # ── Compile results ───────────────────────────────────────────────────
        el = ledger_account.execution_ledger
        trades = el.completed_trades
        n = len(trades)
        wins   = sum(1 for t in trades if t.net_pnl > 0)
        losses = n - wins
        net_rets = [t.net_return_pct for t in trades if t.net_return_pct is not None]

        provenance = BacktestProvenance(
            backtest_id=cfg.backtest_id,
            config_hash=cfg.config_hash,
            git_commit=git_commit,
            dataset_id=decisions[0].dataset_id if decisions else "",
            universe_version="",
            feature_set_id=decisions[0].feature_set_id if decisions else "",
            label_version=decisions[0].label_version if decisions else "lv2",
            primary_model_id=decisions[0].model_id if decisions else "",
            meta_model_id=decisions[0].meta_model_id if decisions else "",
            calibrator_id=decisions[0].calibrator_id if decisions else "",
            cost_schedule_version=cfg.cost_schedule_version,
            slippage_model_version=cfg.slippage_model_version,
            instrument_metadata_version=cfg.instrument_metadata_version,
            execution_engine_version=cfg.execution_engine_version,
            n_oos_decisions=len(decisions),
            run_timestamp=datetime.now(UTC),
        )

        return BacktestResult(
            provenance=provenance,
            ledger=el,
            turnover=ledger_account.turnover,
            final_cash_inr=ledger_account.portfolio.cash_inr,
            initial_capital_inr=cfg.initial_capital_inr,
            total_gross_pnl=el.total_gross_pnl,
            total_cost=el.total_cost,
            total_net_pnl=el.total_net_pnl,
            n_trades=n,
            n_wins=wins,
            n_losses=losses,
            win_rate=wins / n if n > 0 else None,
            avg_net_return_pct=float(np.mean(net_rets)) if net_rets else None,
            gross_turnover_inr=ledger_account.turnover.gross_turnover_inr,
            cost_to_gross_ratio=(
                abs(el.total_cost / el.total_gross_pnl)
                if abs(el.total_gross_pnl) > 0 else None
            ),
            execution_data_level=ExecutionDataLevel.C,
            n_rejected_orders=n_rejected,
            n_unavailable_fills=n_unavailable,
            n_partial_fills=n_partial,
        )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _find_bar_index(
        self, bars: list[OHLCBar], target: datetime
    ) -> Optional[int]:
        """Find bar whose timestamp matches target (by date, not exact time)."""
        target_date = target.date() if hasattr(target, 'date') else target
        for i, bar in enumerate(bars):
            bar_date = bar.timestamp.date() if hasattr(bar.timestamp, 'date') else bar.timestamp
            if bar_date == target_date:
                return i
        return None

    def _make_exit_fill(
        self,
        entry_fill: SimulatedFill,
        bar:        OHLCBar,
        price:      float,
        side:       TradeSide,
        reason:     str,
    ) -> SimulatedFill:
        """Build a synthetic exit fill at the given bar and price."""
        # Apply slippage adversely
        slippage_frac = self.config.slippage_bps / 10_000.0
        if side == TradeSide.LONG:
            adj_price = price * (1.0 - slippage_frac)  # sell at lower price
            order_side = OrderSide.SELL
        else:
            adj_price = price * (1.0 + slippage_frac)  # buy back at higher price
            order_side = OrderSide.BUY

        from .schemas import make_fill_id
        return SimulatedFill(
            fill_id=make_fill_id(),
            order_id=entry_fill.order_id + "_EXIT",
            instrument_id=entry_fill.instrument_id,
            side=side,
            order_side=order_side,
            status=FillStatus.FULL,
            signal_time=bar.timestamp,
            decision_time=bar.timestamp,
            order_time=bar.timestamp,
            eligible_fill_time=bar.timestamp,
            actual_fill_time=bar.timestamp,
            quantity_requested_lots=entry_fill.quantity_filled_lots,
            quantity_filled_lots=entry_fill.quantity_filled_lots,
            fill_ratio=1.0,
            fill_price=adj_price,
            signal_price=bar.close,
            spread_status=SpreadDataStatus.PROXY,
            execution_data_level=ExecutionDataLevel.C,
            rejection_reason=reason,
        )
