"""
Phase 3G — Execution-Aware Backtesting Package.

Converts ML pipeline outputs (alpha scores, calibrated probabilities, EV,
decisions) into realistically executable simulated trades with India-native
cost models, slippage, liquidity constraints, and position accounting.

Public surface
--------------
    from src.execution.schemas import (
        OrderIntent, SimulatedFill, TradeRecord, ExecutionLedger,
        FillStatus, ExecutionPolicy, ProductType, InstrumentType,
        SpreadDataStatus, SlippageModel,
    )
    from src.execution.cost_model import (
        IndiaEquityCostSchedule, IndiaFnOCostSchedule,
        CostScheduleRegistry, compute_trade_cost, CostBreakdown,
    )
    from src.execution.slippage import (
        FixedBPSSlippage, SpreadProxySlippage,
        VolatilityParticipationSlippage, SlippageModelRegistry,
    )
    from src.execution.market_calendar import NSECalendar
    from src.execution.fill_engine import FillEngine, FillEngineConfig
    from src.execution.position_accounting import (
        Position, PortfolioState, TradeAccountingLedger,
    )
    from src.execution.backtest_engine import (
        BacktestEngine, BacktestConfig, BacktestProvenance, BacktestResult,
    )
"""
