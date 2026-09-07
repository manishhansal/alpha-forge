"""
Phase 3L — Phase 3G execution-simulator bridge (spec §5, §13, §14, §15, §85).

The RL layer NEVER builds its own execution simulator. This bridge converts a
policy's decisions into the exact inputs the Phase 3G `BacktestEngine` consumes
and reads realized, cost-aware economics back out. RL, TWAP, VWAP, and every
baseline all run through THIS bridge so comparisons use identical market data,
cost model, slippage, and liquidity (spec §41, §85 baseline integrity).

Simulator parity (spec §14): the bridge records an `ExecutionSimulatorVersion`
derived from the `BacktestConfig.config_hash`. If the simulator config changes,
the version changes.

No simulator cheating (spec §15): the bridge passes ONLY historical bars to the
engine; it never injects future spread/volume/price into a decision. The engine
itself is event-driven and fills on subsequent bars.

Determinism: no np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from src.execution.backtest_engine import (
    BacktestEngine, BacktestConfig, OOSDecisionRecord, BacktestResult,
)
from src.execution.fill_engine import OHLCBar
from src.execution.schemas import TradeSide, InstrumentType, ProductType

from .schemas import ExecutionSimulatorVersion
from .environment import MarketBar


def market_bars_to_ohlc(bars: list[MarketBar]) -> list[OHLCBar]:
    """Convert RL MarketBars to Phase 3G OHLCBars (no data invented)."""
    out: list[OHLCBar] = []
    for b in bars:
        out.append(OHLCBar(
            timestamp=b.timestamp, open=b.open, high=b.high, low=b.low,
            close=b.close, volume=b.volume, adv_inr=b.adv_inr, atr_pct=b.atr_pct,
        ))
    return out


@dataclass
class SimulatedEpisodeResult:
    """Realized economics for a policy's episode, from the Phase 3G engine."""
    total_net_pnl:      float
    total_gross_pnl:    float
    total_cost:         float
    gross_turnover_inr: float
    n_trades:           int
    win_rate:           Optional[float]
    max_drawdown_inr:   Optional[float]
    n_rejected:         int
    n_unavailable:      int
    n_partial:          int
    pnl_reconciled:     bool
    simulator_version:  str
    config_hash:        str
    trades:             list = field(default_factory=list)   # list[TradeRecord]

    def to_dict(self) -> dict:
        return {
            "total_net_pnl": round(self.total_net_pnl, 4),
            "total_gross_pnl": round(self.total_gross_pnl, 4),
            "total_cost": round(self.total_cost, 4),
            "gross_turnover_inr": round(self.gross_turnover_inr, 4),
            "n_trades": self.n_trades,
            "win_rate": self.win_rate,
            "max_drawdown_inr": self.max_drawdown_inr,
            "n_rejected": self.n_rejected,
            "n_unavailable": self.n_unavailable,
            "n_partial": self.n_partial,
            "pnl_reconciled": self.pnl_reconciled,
            "simulator_version": self.simulator_version,
            "config_hash": self.config_hash,
        }


class SimulatorBridge:
    """
    Thin adapter over the Phase 3G BacktestEngine. Every policy (RL or baseline)
    emits `OOSDecisionRecord`s; the bridge runs them through the SAME engine.
    """

    def __init__(self, config: Optional[BacktestConfig] = None,
                 cost_registry=None):
        self.config = config or BacktestConfig(backtest_id="rl-sim")
        self._engine = BacktestEngine(config=self.config, cost_registry=cost_registry)

    def simulator_version(self) -> ExecutionSimulatorVersion:
        """Pin the exact simulator used (spec §14)."""
        return ExecutionSimulatorVersion(
            execution_engine_version=self.config.execution_engine_version,
            cost_schedule_version=self.config.cost_schedule_version,
            slippage_model_version=self.config.slippage_model_version,
            market_calendar_version="nse-calendar-v1",
            backtest_config_hash=self.config.config_hash,
        )

    def run_decisions(
        self,
        decisions: list[OOSDecisionRecord],
        price_data: dict[str, list[OHLCBar]],
        fno_ban_dates: Optional[dict] = None,
        git_commit: str = "unknown",
    ) -> SimulatedEpisodeResult:
        """Run decisions through the Phase 3G engine and summarise realized economics."""
        result: BacktestResult = self._engine.run(
            decisions=decisions, price_data=price_data,
            fno_ban_dates=fno_ban_dates, git_commit=git_commit,
        )
        sv = self.simulator_version()
        return SimulatedEpisodeResult(
            total_net_pnl=result.total_net_pnl,
            total_gross_pnl=result.total_gross_pnl,
            total_cost=result.total_cost,
            gross_turnover_inr=result.gross_turnover_inr,
            n_trades=result.n_trades,
            win_rate=result.win_rate,
            max_drawdown_inr=result.max_drawdown_inr,
            n_rejected=result.n_rejected_orders,
            n_unavailable=result.n_unavailable_fills,
            n_partial=result.n_partial_fills,
            pnl_reconciled=result.pnl_reconciled(),
            simulator_version=sv.version_id,
            config_hash=self.config.config_hash,
            trades=list(result.ledger.completed_trades),
        )


def make_decision(
    instrument_id: str,
    signal_time: datetime,
    trade_side: TradeSide,
    horizon_bars: int,
    entry_price_hint: Optional[float] = None,
    stop_price_hint: Optional[float] = None,
    target_price_hint: Optional[float] = None,
    instrument_type: InstrumentType = InstrumentType.FUT_IDX,
    product_type: ProductType = ProductType.NRML,
    lot_size: int = 1,
    model_id: str = "rl-policy",
    model_version: str = "v1",
) -> OOSDecisionRecord:
    """Build a Phase 3G OOSDecisionRecord for a single TAKE decision."""
    return OOSDecisionRecord(
        instrument_id=instrument_id,
        signal_time=signal_time,
        trade_side=trade_side,
        alpha_score=None,
        meta_probability=None,
        expected_value=None,
        decision="TAKE",
        horizon_bars=horizon_bars,
        entry_price_hint=entry_price_hint,
        stop_price_hint=stop_price_hint,
        target_price_hint=target_price_hint,
        instrument_type=instrument_type,
        product_type=product_type,
        lot_size=lot_size,
        model_id=model_id,
        model_version=model_version,
    )
