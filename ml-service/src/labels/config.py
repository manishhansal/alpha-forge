"""
Label Configuration — versioned, hashable configuration objects for Label V2.

Every dataset must record its label_config_hash so that re-running with
identical configuration produces identical labels (reproducibility).

Changing any material parameter bumps the label version or creates a new
config hash — downstream training detects the mismatch and refuses to mix
datasets with different label configurations.

Usage
-----
::
    cfg = LabelConfig.default_daily()
    print(cfg.hash)       # deterministic 8-char hex

    cfg2 = LabelConfig(pt_multiplier=2.0, sl_multiplier=1.0, horizon_bars=20)
    # cfg2.hash != cfg.hash because pt_multiplier differs
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class CostModelConfig:
    """
    NSE transaction cost model.
    Expressed as fraction of trade value (one way), not round-trip.
    """

    version: str = "DATA_UNAVAILABLE"

    # Per-leg costs as fraction of notional value
    brokerage:        float = 0.0       # 0.0003 for 0.03%
    stt_sell:         float = 0.0001    # 0.01% futures sell; 0.1% options
    exchange_charge:  float = 0.0000345 # NSE transaction charge
    sebi_charge:      float = 0.0000001
    stamp_duty:       float = 0.000020  # buy side
    gst_on_brokerage: float = 0.18      # 18% GST on brokerage

    # Slippage model
    slippage_pct:     float = 0.0       # 0.001 = 0.1% one way

    @property
    def round_trip_cost_pct(self) -> float:
        """Approximate round-trip cost as % of trade value."""
        if self.version == "DATA_UNAVAILABLE":
            return 0.0
        brokerage_total = self.brokerage * 2 * (1 + self.gst_on_brokerage)
        stt = self.stt_sell                    # sell side only for futures
        exchange = self.exchange_charge * 2
        sebi = self.sebi_charge * 2
        stamp = self.stamp_duty                # buy side only
        slippage = self.slippage_pct * 2
        return (brokerage_total + stt + exchange + sebi + stamp + slippage) * 100

    @classmethod
    def futures_nse(cls) -> "CostModelConfig":
        """Approximate NSE futures round-trip cost (~0.15%)."""
        return cls(
            version="nse-futures-v1",
            brokerage=0.0003,
            stt_sell=0.0001,
            exchange_charge=0.0000345,
            sebi_charge=0.0000001,
            stamp_duty=0.00002,
            gst_on_brokerage=0.18,
            slippage_pct=0.0005,
        )

    @classmethod
    def unavailable(cls) -> "CostModelConfig":
        return cls(version="DATA_UNAVAILABLE")


@dataclass
class LabelConfig:
    """
    Versioned configuration for Label V2 generation.

    All barrier and horizon parameters live here.
    Changing any parameter changes the config hash, which means a new
    label version is effectively created.
    """

    version:               str   = "lv2"
    horizon_bars:          int   = 20     # vertical barrier / max holding period
    pt_multiplier:         float = 1.5    # profit-taking barrier = vol * pt_mult
    sl_multiplier:         float = 1.0    # stop-loss barrier = vol * sl_mult
    volatility_window:     int   = 20     # lookback for volatility estimate (ATR/σ)
    volatility_type:       str   = "ATR"  # "ATR" | "STDDEV" | "PARKINSON"
    min_volatility:        float = 0.001  # floor to avoid division by zero
    directional_threshold: float = 0.005  # flat zone ±0.5% for directional labels

    bar_frequency:         str   = "1D"   # "1D", "5T", "15T", "60T"
    price_col:             str   = "close"
    high_col:              str   = "high"
    low_col:               str   = "low"

    ambiguity_policy:      str   = "CONSERVATIVE_SL"
    # "CONSERVATIVE_SL"  → ambiguous intrabar: count as SL (worst case)
    # "DATA_AMBIGUOUS"   → mark as INTRABAR_AMBIGUOUS, exclude from training

    include_costs:         bool  = False  # True once cost model is validated
    cost_model:            CostModelConfig = field(
        default_factory=CostModelConfig.unavailable
    )

    # Expiry awareness
    respect_expiry:        bool  = True   # stop event at contract expiry
    rollover_policy:       str   = "NONE" # "NONE" | "NEXT_CONTRACT"

    # Phase 3B metadata
    universe_version:      str   = "static-v1"
    instrument_master_version: str = "best-known-v1"
    corporate_action_version:  str = "DATA_UNAVAILABLE"

    @property
    def hash(self) -> str:
        """
        Deterministic 16-char SHA-256 hex prefix of this configuration.
        Changing any material parameter changes the hash.
        """
        key = {
            "version":           self.version,
            "horizon_bars":      self.horizon_bars,
            "pt_multiplier":     self.pt_multiplier,
            "sl_multiplier":     self.sl_multiplier,
            "vol_window":        self.volatility_window,
            "vol_type":          self.volatility_type,
            "min_vol":           self.min_volatility,
            "dir_threshold":     self.directional_threshold,
            "bar_freq":          self.bar_frequency,
            "ambiguity_policy":  self.ambiguity_policy,
            "include_costs":     self.include_costs,
            "cost_version":      self.cost_model.version,
        }
        s = json.dumps(key, sort_keys=True)
        return hashlib.sha256(s.encode()).hexdigest()[:16]

    @classmethod
    def default_daily(cls) -> "LabelConfig":
        """Default daily-bar label config for Indian equity/F&O."""
        return cls(
            version="lv2",
            horizon_bars=20,
            pt_multiplier=1.5,
            sl_multiplier=1.0,
            volatility_window=20,
            volatility_type="ATR",
            bar_frequency="1D",
            ambiguity_policy="CONSERVATIVE_SL",
        )

    @classmethod
    def ranking_daily(cls) -> "LabelConfig":
        """Config for cross-sectional ranking labels (shorter horizon)."""
        return cls(
            version="lv2",
            horizon_bars=5,
            pt_multiplier=1.5,
            sl_multiplier=1.0,
            volatility_window=10,
            volatility_type="ATR",
            bar_frequency="1D",
            ambiguity_policy="CONSERVATIVE_SL",
        )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["hash"] = self.hash
        return d
