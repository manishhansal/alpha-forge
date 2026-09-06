"""
Phase 3G — Pluggable Slippage Models.

Four models are supported:

  A  FixedBPSSlippage           — constant BPS; for sensitivity testing only
  B  SpreadProxySlippage         — half-spread from OHLC range or volume
  C  VolatilityParticipationSlippage — σ × sqrt(order_size/ADV) style
  D  MarketImpactSlippage        — parametric square-root model

Model selection contract
------------------------
- Each model documents what data it requires.
- If required data is absent, the model returns SpreadDataStatus.UNAVAILABLE
  and slippage_bps = 0.0 (not a fabricated value).
- Models must not claim OBSERVED status unless real bid-ask data is provided.

Output
------
Every model returns SlippageEstimate with:
  slippage_bps    : estimated one-way slippage in basis points
  spread_status   : OBSERVED / PROXY / UNAVAILABLE
  model_version   : which model produced this estimate
  data_evidence   : ExecutionDataLevel (A/B/C/D)
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from .schemas import ExecutionDataLevel, SpreadDataStatus


SLIPPAGE_MODEL_VERSION = "slippage-v1"


@dataclass
class SlippageEstimate:
    """Output of a slippage model for one order."""
    slippage_bps:      float                # one-way slippage in basis points
    spread_status:     SpreadDataStatus
    data_evidence:     ExecutionDataLevel
    model_id:          str
    model_version:     str
    notes:             str = ""

    @property
    def slippage_pct(self) -> float:
        """Slippage as fraction of price (not percentage)."""
        return self.slippage_bps / 10_000.0


# ── Base interface ────────────────────────────────────────────────────────────

class BaseSlippageModel(ABC):
    @property
    @abstractmethod
    def model_id(self) -> str: ...

    @property
    @abstractmethod
    def model_version(self) -> str: ...

    @abstractmethod
    def estimate(
        self,
        price:           float,
        quantity_units:  int,
        adv_inr:         Optional[float] = None,    # average daily value ₹
        high:            Optional[float] = None,
        low:             Optional[float] = None,
        close:           Optional[float] = None,
        volume:          Optional[float] = None,
        atr_pct:         Optional[float] = None,    # ATR as % of price
        observed_spread_bps: Optional[float] = None,
    ) -> SlippageEstimate:
        ...


# ── Model A — Fixed BPS ───────────────────────────────────────────────────────

class FixedBPSSlippage(BaseSlippageModel):
    """
    Model A: Fixed BPS slippage for controlled sensitivity testing.

    Use this ONLY when you need a controlled baseline or sensitivity
    scenario with an explicit, documented slippage assumption.
    This model makes no claim about what realistic slippage is.

    Required data: none (uses configured value directly)
    Evidence level: D (parametric assumption, no market data)
    """

    def __init__(self, fixed_bps: float = 5.0):
        """
        Parameters
        ----------
        fixed_bps : one-way slippage in basis points (default 5bps = 0.05%)
        """
        self._bps = fixed_bps

    @property
    def model_id(self) -> str:
        return "fixed_bps"

    @property
    def model_version(self) -> str:
        return f"fixed_bps-{self._bps}bps-{SLIPPAGE_MODEL_VERSION}"

    def estimate(self, price, quantity_units, **kwargs) -> SlippageEstimate:
        return SlippageEstimate(
            slippage_bps=self._bps,
            spread_status=SpreadDataStatus.UNAVAILABLE,
            data_evidence=ExecutionDataLevel.D,
            model_id=self.model_id,
            model_version=self.model_version,
            notes=f"Fixed {self._bps}bps — sensitivity scenario only",
        )


# ── Model B — Spread Proxy ────────────────────────────────────────────────────

class SpreadProxySlippage(BaseSlippageModel):
    """
    Model B: Spread estimated from OHLC range and volume data.

    Two proxy approaches:
      1. HL proxy: half-spread ≈ (high - low) / close × k_hl
         where k_hl is a scaling factor (~0.25..0.40 for liquid instruments)
      2. Volume proxy: adjusted spread based on volume relative to ADV.

    Data required: OHLC at minimum; volume improves accuracy.
    Evidence level: C (derived proxy — not real bid-ask)
    """

    def __init__(self, hl_scaling_factor: float = 0.30):
        """
        Parameters
        ----------
        hl_scaling_factor : fraction of H-L range used as half-spread estimate.
                            0.30 is typical for liquid NSE F&O instruments.
        """
        self._k = hl_scaling_factor

    @property
    def model_id(self) -> str:
        return "spread_proxy"

    @property
    def model_version(self) -> str:
        return f"spread_proxy-k{self._k}-{SLIPPAGE_MODEL_VERSION}"

    def estimate(
        self,
        price:           float,
        quantity_units:  int,
        high:            Optional[float] = None,
        low:             Optional[float] = None,
        close:           Optional[float] = None,
        volume:          Optional[float] = None,
        adv_inr:         Optional[float] = None,
        observed_spread_bps: Optional[float] = None,
        **kwargs,
    ) -> SlippageEstimate:
        # If real bid-ask is available, use it
        if observed_spread_bps is not None:
            return SlippageEstimate(
                slippage_bps=observed_spread_bps / 2.0,  # half-spread as slippage
                spread_status=SpreadDataStatus.OBSERVED,
                data_evidence=ExecutionDataLevel.A,
                model_id=self.model_id,
                model_version=self.model_version,
                notes="Observed bid-ask spread used",
            )

        # HL proxy
        if high is not None and low is not None and price > 0:
            hl_range = high - low
            if hl_range <= 0 or price <= 0:
                return SlippageEstimate(
                    slippage_bps=0.0,
                    spread_status=SpreadDataStatus.UNAVAILABLE,
                    data_evidence=ExecutionDataLevel.D,
                    model_id=self.model_id,
                    model_version=self.model_version,
                    notes="HL range zero or negative",
                )
            # Half-spread in BPS
            half_spread_pct = (hl_range / price) * self._k
            half_spread_bps = half_spread_pct * 10_000

            # If volume data available, apply liquidity adjustment
            volume_factor = 1.0
            if volume is not None and adv_inr is not None and adv_inr > 0:
                order_value = price * quantity_units
                participation = order_value / adv_inr
                if participation > 0:
                    # Higher participation → wider spread (mild linear penalty)
                    volume_factor = 1.0 + min(participation * 5.0, 2.0)

            adjusted_bps = half_spread_bps * volume_factor

            return SlippageEstimate(
                slippage_bps=adjusted_bps,
                spread_status=SpreadDataStatus.PROXY,
                data_evidence=ExecutionDataLevel.C,
                model_id=self.model_id,
                model_version=self.model_version,
                notes=(
                    f"HL proxy: range={hl_range:.2f}, k={self._k}, "
                    f"half-spread≈{half_spread_bps:.1f}bps"
                ),
            )

        # No usable data
        return SlippageEstimate(
            slippage_bps=0.0,
            spread_status=SpreadDataStatus.UNAVAILABLE,
            data_evidence=ExecutionDataLevel.D,
            model_id=self.model_id,
            model_version=self.model_version,
            notes="Insufficient OHLC data for spread proxy",
        )


# ── Model C — Volatility × Participation ─────────────────────────────────────

class VolatilityParticipationSlippage(BaseSlippageModel):
    """
    Model C: Slippage as a function of volatility and order participation.

    Formula:
        slippage_bps = coeff × atr_pct × sqrt(participation_rate) × 10_000

    where:
        atr_pct          = ATR / price (as fraction)
        participation_rate = order_notional / adv_inr

    This is conceptually similar to the Almgren-Chriss framework with a
    simplified linear-in-vol, square-root-in-participation structure.

    Data required: ATR (or volatility estimate) + ADV
    Evidence level: C (parametric proxy — not calibrated to real execution)
    Limitation: The coefficient (default 0.5) is NOT empirically calibrated
                against real Indian market execution data. Use for research
                scenario analysis only, not production capacity claims.
    """

    def __init__(self, coefficient: float = 0.5, max_slippage_bps: float = 50.0):
        """
        Parameters
        ----------
        coefficient     : scaling factor (PROXY value — not calibrated)
        max_slippage_bps: cap to prevent extreme estimates
        """
        self._coeff = coefficient
        self._max_bps = max_slippage_bps

    @property
    def model_id(self) -> str:
        return "vol_participation"

    @property
    def model_version(self) -> str:
        return f"vol_participation-c{self._coeff}-{SLIPPAGE_MODEL_VERSION}"

    def estimate(
        self,
        price:           float,
        quantity_units:  int,
        atr_pct:         Optional[float] = None,   # ATR/price (fraction)
        adv_inr:         Optional[float] = None,
        **kwargs,
    ) -> SlippageEstimate:
        if atr_pct is None or adv_inr is None or adv_inr <= 0 or price <= 0:
            return SlippageEstimate(
                slippage_bps=0.0,
                spread_status=SpreadDataStatus.UNAVAILABLE,
                data_evidence=ExecutionDataLevel.D,
                model_id=self.model_id,
                model_version=self.model_version,
                notes="Missing atr_pct or adv_inr",
            )

        order_notional = price * quantity_units
        participation  = order_notional / adv_inr
        participation  = max(0.0, min(participation, 1.0))  # cap at 100% ADV

        slippage_bps = self._coeff * (atr_pct * 10_000) * math.sqrt(participation)
        slippage_bps = min(slippage_bps, self._max_bps)

        return SlippageEstimate(
            slippage_bps=slippage_bps,
            spread_status=SpreadDataStatus.PROXY,
            data_evidence=ExecutionDataLevel.C,
            model_id=self.model_id,
            model_version=self.model_version,
            notes=(
                f"vol×participation: atr_pct={atr_pct:.4f}, "
                f"participation={participation:.4f}, "
                f"coeff={self._coeff} (NOT calibrated to real execution data)"
            ),
        )


# ── Model D — Market Impact (Square-Root) ─────────────────────────────────────

class MarketImpactSlippage(BaseSlippageModel):
    """
    Model D: Square-root market impact model.

    impact_bps = eta × σ × sqrt(Q / ADV)

    where:
        eta = market-impact coefficient (PROXY — not calibrated)
        σ   = daily volatility (std of returns, as fraction)
        Q   = order size (units)
        ADV = average daily volume (units, not value)

    This is a common parametric form used in academic finance.
    The coefficient eta is NOT calibrated to real Indian market data.
    Use this model for ORDER-OF-MAGNITUDE capacity analysis only.
    """

    def __init__(self, eta: float = 0.1, max_slippage_bps: float = 100.0):
        self._eta = eta
        self._max_bps = max_slippage_bps

    @property
    def model_id(self) -> str:
        return "market_impact"

    @property
    def model_version(self) -> str:
        return f"market_impact-eta{self._eta}-{SLIPPAGE_MODEL_VERSION}"

    def estimate(
        self,
        price:            float,
        quantity_units:   int,
        adv_inr:          Optional[float] = None,  # daily ₹ volume
        atr_pct:          Optional[float] = None,  # ATR/price as daily vol proxy
        volume:           Optional[float] = None,  # today's volume (units)
        **kwargs,
    ) -> SlippageEstimate:
        if atr_pct is None or adv_inr is None or adv_inr <= 0 or price <= 0:
            return SlippageEstimate(
                slippage_bps=0.0,
                spread_status=SpreadDataStatus.UNAVAILABLE,
                data_evidence=ExecutionDataLevel.D,
                model_id=self.model_id,
                model_version=self.model_version,
                notes="Missing atr_pct or adv_inr",
            )

        # Convert ADV ₹ → ADV units
        adv_units = adv_inr / price if price > 0 else 1
        if adv_units <= 0:
            adv_units = 1

        q_over_adv = quantity_units / adv_units
        sigma = atr_pct  # use ATR/price as daily vol proxy (rough)

        impact_bps = self._eta * (sigma * 10_000) * math.sqrt(q_over_adv)
        impact_bps = min(impact_bps, self._max_bps)

        return SlippageEstimate(
            slippage_bps=impact_bps,
            spread_status=SpreadDataStatus.PROXY,
            data_evidence=ExecutionDataLevel.C,
            model_id=self.model_id,
            model_version=self.model_version,
            notes=(
                f"Square-root impact: eta={self._eta} (NOT calibrated), "
                f"sigma_bps={sigma*10000:.1f}, Q/ADV={q_over_adv:.4f}"
            ),
        )


# ── Slippage registry ─────────────────────────────────────────────────────────

class SlippageModelRegistry:
    """Registry of slippage models. Use get() to retrieve by model_id."""

    _models: dict[str, BaseSlippageModel] = {}

    @classmethod
    def register(cls, model: BaseSlippageModel) -> None:
        cls._models[model.model_id] = model

    @classmethod
    def get(cls, model_id: str) -> BaseSlippageModel:
        if model_id not in cls._models:
            raise KeyError(f"Slippage model '{model_id}' not registered.")
        return cls._models[model_id]

    @classmethod
    def all_ids(cls) -> list[str]:
        return list(cls._models.keys())


# Register defaults
SlippageModelRegistry.register(FixedBPSSlippage(fixed_bps=0.0))
SlippageModelRegistry.register(FixedBPSSlippage(fixed_bps=5.0))
SlippageModelRegistry.register(SpreadProxySlippage())
SlippageModelRegistry.register(VolatilityParticipationSlippage())
SlippageModelRegistry.register(MarketImpactSlippage())
