"""
Dealer GEX (Gamma Exposure) Engine for NSE option chains.

Computes per-strike GEX, aggregate GEX, gamma flip level, expected daily
move band, and GEX walls from a chain snapshot.

Sign convention (dealer perspective):
  - Dealers are net *short* calls  → CE GEX is negative  (destabilising)
  - Dealers are net *short* puts   → PE GEX is positive   (stabilising)

  ce_gex  = gamma × ce_oi × lot_size × spot²  × (−1)
  pe_gex  = gamma × pe_oi × lot_size × spot²  × (+1)
  net_gex = ce_gex + pe_gex

Gamma flip: strike where the *cumulative* sum of per-strike GEX (sorted
ascending) crosses zero.  Above the flip price the market is in positive
GEX territory (dealers stabilise); below it dealers are de-stabilising.

Expected daily move: derived from aggregate GEX and total open interest.

Validates: Requirements 4.1, 4.2, 4.3, 4.4
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Canonical NSE lot sizes
# ---------------------------------------------------------------------------

LOT_SIZES: dict[str, int] = {
    "NIFTY": 50,
    "BANKNIFTY": 15,
    "FINNIFTY": 40,
    "MIDCPNIFTY": 75,
}

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def compute_gex(
    chain_snapshot: list[dict],
    spot: float,
    lot_size: int | float,
) -> dict:
    """
    Compute Dealer Gamma Exposure (GEX) from an NSE option chain snapshot.

    Parameters
    ----------
    chain_snapshot : list of dicts, each containing:
                       'strike'   (float)  — option strike price
                       'ce_gamma' (float)  — call gamma per share
                       'pe_gamma' (float)  — put gamma per share
                       'ce_oi'    (float)  — call open interest (lots or contracts)
                       'pe_oi'    (float)  — put open interest (lots or contracts)
                     When ce_gamma / pe_gamma are absent or zero, callers should
                     pre-enrich the chain using greeks.compute_chain_greeks()
                     (Requirement 4.4).
    spot           : current spot / index level (must be > 0)
    lot_size       : NSE contract lot size (e.g. 50 for NIFTY).
                     Use LOT_SIZES[symbol] for the canonical value.

    Returns
    -------
    dict with keys:
      strikes           — list[float], strike prices sorted ascending
      gex_per_strike    — list[float], per-strike GEX (negative = destabilising)
      aggregate_gex     — float, Σ gex_per_strike
      gamma_flip        — float, strike where cumulative GEX crosses zero
      expected_move_pct — float, expected daily move as a percentage (always > 0)
      positive_gex_wall — float, strike with strongest positive GEX (support)
      negative_gex_wall — float, strike with strongest negative GEX (resistance)

    Sign convention:
      - CE exposure:  negative  (dealers short calls)
      - PE exposure:  positive  (dealers short puts)

    Validates: Requirements 4.1, 4.2, 4.3
    """
    gex_per_strike: list[float] = []
    strikes: list[float] = []

    for row in sorted(chain_snapshot, key=lambda r: r["strike"]):
        ce_gex = row["ce_gamma"] * row["ce_oi"] * lot_size * spot ** 2 * (-1)
        pe_gex = row["pe_gamma"] * row["pe_oi"] * lot_size * spot ** 2 * (+1)
        net_gex = ce_gex + pe_gex
        gex_per_strike.append(net_gex)
        strikes.append(row["strike"])

    aggregate_gex = sum(gex_per_strike)

    # -----------------------------------------------------------------------
    # Gamma flip: strike where cumulative GEX crosses zero (sorted ascending)
    # -----------------------------------------------------------------------
    cumulative = 0.0
    gamma_flip = strikes[0] if strikes else spot  # default to first strike
    for strike, gex in zip(strikes, gex_per_strike):
        prev_cumulative = cumulative
        cumulative += gex
        if prev_cumulative * cumulative < 0:  # sign change → zero crossing
            gamma_flip = strike
            break

    # -----------------------------------------------------------------------
    # Expected daily move
    # -----------------------------------------------------------------------
    total_oi = sum(row["ce_oi"] + row["pe_oi"] for row in chain_snapshot)
    if total_oi > 0 and spot > 0:
        expected_move_pct = (
            abs(aggregate_gex) / (spot ** 2 * total_oi * lot_size) * spot
        )
        # Ensure strictly positive (never zero for valid inputs)
        expected_move_pct = max(expected_move_pct, 1e-10)
    else:
        expected_move_pct = 1e-10

    # -----------------------------------------------------------------------
    # GEX walls
    # -----------------------------------------------------------------------
    # Negative GEX strikes (CE-dominated) = resistance zones
    ce_gex_per_strike = [
        (s, g) for s, g in zip(strikes, gex_per_strike) if g < 0
    ]
    # Positive GEX strikes (PE-dominated) = support zones
    pe_gex_per_strike = [
        (s, g) for s, g in zip(strikes, gex_per_strike) if g > 0
    ]

    # Positive wall: strike with the *largest* positive GEX value (strongest support)
    positive_gex_wall = (
        max(pe_gex_per_strike, key=lambda x: x[1])[0]
        if pe_gex_per_strike
        else spot
    )
    # Negative wall: strike with the *most negative* GEX value (strongest resistance)
    negative_gex_wall = (
        min(ce_gex_per_strike, key=lambda x: x[1])[0]
        if ce_gex_per_strike
        else spot
    )

    return {
        "strikes": strikes,
        "gex_per_strike": gex_per_strike,
        "aggregate_gex": aggregate_gex,
        "gamma_flip": gamma_flip,
        "expected_move_pct": expected_move_pct,
        "positive_gex_wall": positive_gex_wall,
        "negative_gex_wall": negative_gex_wall,
    }
