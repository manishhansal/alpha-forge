"""
Phase 3Q — Signal-family data-dependency matrix + double-counting audit (spec §34-§35).

This is a DOCUMENTATION / CONTRACT module. It declares, for each signal family,
exactly what data it requires (provider surface, timeframe, minimum history,
point-in-time requirement, failure behaviour, and the availability status it must
report when data is missing). It also records a double-counting audit that
DOCUMENTS which families overlap — it does NOT remove any family or re-weight
anything (spec §35 explicitly: document only).

Nothing here computes a signal or touches a model. It is the canonical
signal-data contract that Task 8 tests assert against and Task 10 docs reference.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SignalFamily(str, Enum):
    PRICE_ACTION            = "PRICE_ACTION"
    TREND                   = "TREND"
    MOMENTUM                = "MOMENTUM"
    VOLATILITY              = "VOLATILITY"
    VOLUME                  = "VOLUME"
    VWAP                    = "VWAP"
    MARKET_STRUCTURE        = "MARKET_STRUCTURE"
    FVG                     = "FVG"                 # fair value gaps
    ORDER_BLOCKS            = "ORDER_BLOCKS"
    LIQUIDITY               = "LIQUIDITY"
    DERIVATIVES             = "DERIVATIVES"
    OPEN_INTEREST           = "OPEN_INTEREST"
    PCR                     = "PCR"                 # put/call ratio
    IMPLIED_VOLATILITY      = "IMPLIED_VOLATILITY"
    GEX                     = "GEX"                 # gamma exposure
    GREEKS                  = "GREEKS"
    IV_REGIME               = "IV_REGIME"
    MACRO                   = "MACRO"
    RELATIVE_STRENGTH       = "RELATIVE_STRENGTH"
    CROSS_SECTIONAL_RANKING = "CROSS_SECTIONAL_RANKING"
    REGIME                  = "REGIME"
    ML_PREDICTION           = "ML_PREDICTION"
    META_PROBABILITY        = "META_PROBABILITY"
    PORTFOLIO_RISK          = "PORTFOLIO_RISK"
    EXECUTION               = "EXECUTION"


class DataSurface(str, Enum):
    """The upstream data surface a family consumes."""
    EQUITY_OHLCV      = "EQUITY_OHLCV"
    DERIVATIVES_CHAIN = "DERIVATIVES_CHAIN"
    OPTION_GREEKS     = "OPTION_GREEKS"
    OPEN_INTEREST     = "OPEN_INTEREST"
    MACRO_SERIES      = "MACRO_SERIES"
    CROSS_SECTION     = "CROSS_SECTION"       # universe-wide snapshot
    MODEL_OUTPUT      = "MODEL_OUTPUT"        # depends on upstream model
    PORTFOLIO_STATE   = "PORTFOLIO_STATE"


class PITRequirement(str, Enum):
    STRICT   = "STRICT"      # must be point-in-time correct (no future leak)
    RELAXED  = "RELAXED"     # tolerant (e.g. slow macro series)
    NONE     = "NONE"


@dataclass(frozen=True)
class SignalDataContract:
    """
    The data contract for one signal family (spec §34). `failure_availability` is
    the FeatureAvailability value the family must report when its data is missing
    — never a silent 0.0.
    """
    family:               str            # SignalFamily value
    surfaces:             tuple[str, ...]
    timeframes:           tuple[str, ...]
    min_history_bars:     int
    pit_requirement:      str            # PITRequirement value
    failure_behavior:     str            # human-readable: what happens on missing data
    failure_availability: str            # FeatureAvailability value on missing data
    notes:                str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "family": self.family, "surfaces": list(self.surfaces),
            "timeframes": list(self.timeframes),
            "minHistoryBars": self.min_history_bars,
            "pitRequirement": self.pit_requirement,
            "failureBehavior": self.failure_behavior,
            "failureAvailability": self.failure_availability,
            "notes": self.notes,
        }


# Import the availability vocabulary so the contract references the real enum.
from .feature_availability import FeatureAvailability as _FA

_S = DataSurface
_TF_INTRADAY = ("5m", "15m", "1h")
_TF_ALL = ("5m", "15m", "1h", "1d")


# The canonical matrix (spec §34). Every family reports an EXPLICIT availability
# status on missing data — DATA_INSUFFICIENT / MISSING / NOT_APPLICABLE — never a
# silent neutral value.
SIGNAL_DATA_MATRIX: dict[SignalFamily, SignalDataContract] = {
    SignalFamily.PRICE_ACTION: SignalDataContract(
        SignalFamily.PRICE_ACTION.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 20,
        PITRequirement.STRICT.value,
        "No OHLCV -> no price-action signal.", _FA.DATA_INSUFFICIENT.value),
    SignalFamily.TREND: SignalDataContract(
        SignalFamily.TREND.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 200,
        PITRequirement.STRICT.value,
        "Insufficient history for MA/EMA -> DATA_INSUFFICIENT.",
        _FA.DATA_INSUFFICIENT.value,
        "Long lookback (e.g. 200-bar MA) needs 200 closed bars."),
    SignalFamily.MOMENTUM: SignalDataContract(
        SignalFamily.MOMENTUM.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 14,
        PITRequirement.STRICT.value,
        "RSI/ROC need >= period+1 closed bars.", _FA.DATA_INSUFFICIENT.value),
    SignalFamily.VOLATILITY: SignalDataContract(
        SignalFamily.VOLATILITY.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 20,
        PITRequirement.STRICT.value,
        "ATR/stdev need a window of closed bars.", _FA.DATA_INSUFFICIENT.value),
    SignalFamily.VOLUME: SignalDataContract(
        SignalFamily.VOLUME.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 20,
        PITRequirement.STRICT.value,
        "Volume absent/zero-invalid -> MISSING (not TRUE_ZERO unless genuinely 0).",
        _FA.MISSING.value),
    SignalFamily.VWAP: SignalDataContract(
        SignalFamily.VWAP.value, (_S.EQUITY_OHLCV.value,), _TF_INTRADAY, 1,
        PITRequirement.STRICT.value,
        "VWAP is intraday, session-anchored; needs volume.",
        _FA.DATA_INSUFFICIENT.value,
        "NOT_APPLICABLE on a daily timeframe."),
    SignalFamily.MARKET_STRUCTURE: SignalDataContract(
        SignalFamily.MARKET_STRUCTURE.value, (_S.EQUITY_OHLCV.value,), _TF_ALL, 50,
        PITRequirement.STRICT.value,
        "Swing highs/lows need enough structure.", _FA.DATA_INSUFFICIENT.value),
    SignalFamily.FVG: SignalDataContract(
        SignalFamily.FVG.value, (_S.EQUITY_OHLCV.value,), _TF_INTRADAY, 3,
        PITRequirement.STRICT.value,
        "Fair-value gaps need >= 3 consecutive closed bars.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.ORDER_BLOCKS: SignalDataContract(
        SignalFamily.ORDER_BLOCKS.value, (_S.EQUITY_OHLCV.value,), _TF_INTRADAY, 10,
        PITRequirement.STRICT.value,
        "Order blocks derive from structure + volume.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.LIQUIDITY: SignalDataContract(
        SignalFamily.LIQUIDITY.value, (_S.EQUITY_OHLCV.value,), _TF_INTRADAY, 20,
        PITRequirement.STRICT.value,
        "Liquidity pools/sweeps need swing history.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.DERIVATIVES: SignalDataContract(
        SignalFamily.DERIVATIVES.value, (_S.DERIVATIVES_CHAIN.value,), _TF_INTRADAY, 1,
        PITRequirement.STRICT.value,
        "No derivatives chain -> NOT_APPLICABLE for non-F&O; DATA_INSUFFICIENT for F&O.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.OPEN_INTEREST: SignalDataContract(
        SignalFamily.OPEN_INTEREST.value, (_S.OPEN_INTEREST.value, _S.DERIVATIVES_CHAIN.value),
        _TF_INTRADAY, 2, PITRequirement.STRICT.value,
        "OI change needs >=2 observations; absent OI -> MISSING.",
        _FA.MISSING.value),
    SignalFamily.PCR: SignalDataContract(
        SignalFamily.PCR.value, (_S.DERIVATIVES_CHAIN.value, _S.OPEN_INTEREST.value),
        _TF_INTRADAY, 1, PITRequirement.STRICT.value,
        "Put/call ratio needs both legs of the chain.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.IMPLIED_VOLATILITY: SignalDataContract(
        SignalFamily.IMPLIED_VOLATILITY.value, (_S.DERIVATIVES_CHAIN.value,),
        _TF_INTRADAY, 1, PITRequirement.STRICT.value,
        "IV needs option quotes; absent -> MISSING.", _FA.MISSING.value),
    SignalFamily.GEX: SignalDataContract(
        SignalFamily.GEX.value, (_S.OPTION_GREEKS.value, _S.OPEN_INTEREST.value),
        _TF_INTRADAY, 1, PITRequirement.STRICT.value,
        "Gamma exposure needs greeks + OI across strikes.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.GREEKS: SignalDataContract(
        SignalFamily.GREEKS.value, (_S.OPTION_GREEKS.value,), _TF_INTRADAY, 1,
        PITRequirement.STRICT.value,
        "Greeks absent -> MISSING; never fabricate.", _FA.MISSING.value),
    SignalFamily.IV_REGIME: SignalDataContract(
        SignalFamily.IV_REGIME.value, (_S.DERIVATIVES_CHAIN.value,), _TF_ALL, 60,
        PITRequirement.STRICT.value,
        "IV percentile/rank needs a long IV history.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.MACRO: SignalDataContract(
        SignalFamily.MACRO.value, (_S.MACRO_SERIES.value,), ("1d",), 1,
        PITRequirement.RELAXED.value,
        "Macro series (e.g. INDIA VIX) absent -> MISSING; slow-moving so RELAXED PIT.",
        _FA.MISSING.value),
    SignalFamily.RELATIVE_STRENGTH: SignalDataContract(
        SignalFamily.RELATIVE_STRENGTH.value, (_S.EQUITY_OHLCV.value, _S.CROSS_SECTION.value),
        _TF_ALL, 20, PITRequirement.STRICT.value,
        "RS vs benchmark/peers needs the peer snapshot too.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.CROSS_SECTIONAL_RANKING: SignalDataContract(
        SignalFamily.CROSS_SECTIONAL_RANKING.value, (_S.CROSS_SECTION.value,),
        _TF_ALL, 1, PITRequirement.STRICT.value,
        "Ranking needs the full eligible universe PIT-correct (no survivorship).",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.REGIME: SignalDataContract(
        SignalFamily.REGIME.value, (_S.EQUITY_OHLCV.value, _S.MACRO_SERIES.value),
        _TF_ALL, 60, PITRequirement.STRICT.value,
        "Regime classification needs sufficient history.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.ML_PREDICTION: SignalDataContract(
        SignalFamily.ML_PREDICTION.value, (_S.MODEL_OUTPUT.value,), _TF_ALL, 1,
        PITRequirement.STRICT.value,
        "Model unavailable/incompatible -> NOT_APPLICABLE (signal-safety MODEL_UNAVAILABLE).",
        _FA.NOT_APPLICABLE.value),
    SignalFamily.META_PROBABILITY: SignalDataContract(
        SignalFamily.META_PROBABILITY.value, (_S.MODEL_OUTPUT.value,), _TF_ALL, 1,
        PITRequirement.STRICT.value,
        "Meta-probability depends on base model + calibrator.",
        _FA.NOT_APPLICABLE.value),
    SignalFamily.PORTFOLIO_RISK: SignalDataContract(
        SignalFamily.PORTFOLIO_RISK.value, (_S.PORTFOLIO_STATE.value, _S.EQUITY_OHLCV.value),
        _TF_ALL, 20, PITRequirement.STRICT.value,
        "Risk sizing needs portfolio state + volatility.",
        _FA.DATA_INSUFFICIENT.value),
    SignalFamily.EXECUTION: SignalDataContract(
        SignalFamily.EXECUTION.value, (_S.EQUITY_OHLCV.value,), _TF_INTRADAY, 1,
        PITRequirement.STRICT.value,
        "Execution needs a fresh, closed reference bar.",
        _FA.DATA_INSUFFICIENT.value),
}


def get_contract(family: SignalFamily | str) -> SignalDataContract:
    return SIGNAL_DATA_MATRIX[SignalFamily(family)]


def all_contracts() -> list[SignalDataContract]:
    return list(SIGNAL_DATA_MATRIX.values())


# ── Double-counting audit (spec §35) — DOCUMENT ONLY ────────────────────────────

class OverlapKind(str, Enum):
    INDEPENDENT           = "INDEPENDENT"
    OVERLAPPING           = "OVERLAPPING"
    POTENTIALLY_REDUNDANT = "POTENTIALLY_REDUNDANT"


@dataclass(frozen=True)
class OverlapNote:
    """A documented overlap between two families (spec §35). Advisory ONLY —
    nothing is removed and no weights are changed."""
    family_a: str
    family_b: str
    kind:     str            # OverlapKind value
    rationale: str

    def to_dict(self) -> dict[str, Any]:
        return {"familyA": self.family_a, "familyB": self.family_b,
                "kind": self.kind, "rationale": self.rationale}


# The audit findings. These are OBSERVATIONS for the report; the engine keeps all
# families exactly as they are (spec §35: do NOT remove, do NOT optimize weights).
DOUBLE_COUNTING_AUDIT: tuple[OverlapNote, ...] = (
    OverlapNote(SignalFamily.MOMENTUM.value, SignalFamily.TREND.value,
                OverlapKind.OVERLAPPING.value,
                "RSI/ROC momentum and MA-slope trend both read the same close "
                "series; directional agreement can double-count a single move."),
    OverlapNote(SignalFamily.TREND.value, SignalFamily.PRICE_ACTION.value,
                OverlapKind.OVERLAPPING.value,
                "MACD/EMA trend overlaps with EMA-based price-action structure — "
                "shared moving-average basis."),
    OverlapNote(SignalFamily.VWAP.value, SignalFamily.PRICE_ACTION.value,
                OverlapKind.OVERLAPPING.value,
                "VWAP distance and price-distance-from-reference measure related "
                "displacement from a session anchor."),
    OverlapNote(SignalFamily.OPEN_INTEREST.value, SignalFamily.DERIVATIVES.value,
                OverlapKind.OVERLAPPING.value,
                "OI-change signals are a subset of the derivatives-chain surface; "
                "counting both may over-weight the same OI move."),
    OverlapNote(SignalFamily.FVG.value, SignalFamily.MARKET_STRUCTURE.value,
                OverlapKind.OVERLAPPING.value,
                "Fair-value gaps are a structural construct; overlaps with swing "
                "market-structure detection on the same bars."),
    OverlapNote(SignalFamily.VOLATILITY.value, SignalFamily.IV_REGIME.value,
                OverlapKind.POTENTIALLY_REDUNDANT.value,
                "Realised-vol (ATR/stdev) and implied-vol regime both proxy the "
                "same volatility state through different lenses."),
    OverlapNote(SignalFamily.GEX.value, SignalFamily.GREEKS.value,
                OverlapKind.OVERLAPPING.value,
                "GEX is aggregated gamma from the same greeks surface."),
    OverlapNote(SignalFamily.ML_PREDICTION.value, SignalFamily.META_PROBABILITY.value,
                OverlapKind.POTENTIALLY_REDUNDANT.value,
                "Meta-probability is a calibrated transform of the base ML "
                "prediction; they are not independent."),
)


def audit_notes() -> list[OverlapNote]:
    return list(DOUBLE_COUNTING_AUDIT)
