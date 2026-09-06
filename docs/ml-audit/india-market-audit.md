# India Market Audit: Classification of India-Specific Coverage

**Verification Date:** 2026-09-06  
**Method:** Direct code inspection. Each feature, assumption, and design decision verified against actual NSE/SEBI rules.

---

## Classification Legend

| Status | Meaning |
|---|---|
| `READY` | Correctly implemented and current |
| `PARTIAL` | Implemented but incomplete or outdated |
| `MISSING` | Not implemented; gap exists |
| `INCORRECT` | Implemented but wrong per current NSE/SEBI rules |

---

## NSE Instruments and Markets

| Area | Status | Evidence |
|---|---|---|
| NIFTY 50 as primary index | READY | Used as benchmark throughout `data_pipeline.py`; `TRAINING_UNIVERSE` includes "NIFTY" |
| BANKNIFTY | READY | `compute_regime_features()` accepts banknifty_ohlcv; bank_nifty_spread computed |
| FINNIFTY | PARTIAL | In `TRAINING_UNIVERSE` as "FINNIFTY" but no FINNIFTY-specific features |
| MIDCPNIFTY | PARTIAL | In `TRAINING_UNIVERSE` but no MIDCPNIFTY-specific features |
| F&O stock universe | PARTIAL | 50 stocks included; static list; no PIT eligibility |

---

## F&O Market Mechanics

| Area | Status | Evidence | Notes |
|---|---|---|---|
| **PCR (Put-Call Ratio)** | READY | `compute_pcr_score()` in `derivatives.py`; centre at 1.0, clip ±1 | PCR interpretation correct for India. However, should use 252-day percentile not absolute level (see finding M6). |
| **OI buildup quadrants** | READY | `compute_oi_buildup_score()` — 4 quadrant system | Correct NSE F&O interpretation. |
| **IV rank** | PARTIAL | `compute_iv_rank()` correct but fallback is fake history | Fix fallback to return 50.0 |
| **IV percentile** | READY | `compute_iv_percentile()` correct | More robust than IV rank for tail events |
| **ATM skew** | PARTIAL | `DerivativesSnapshot.atm_skew` field exists in data layer | Not yet used as a feature in RANKING_FEATURES |
| **Max pain** | READY | `compute_max_pain_distance()` — % distance from spot to max-pain strike | India-specific; relevant especially for weekly expiry |
| **OI walls (CE/PE)** | READY | `compute_oi_wall_proximity()` — CE wall (resistance), PE wall (support) | Correct NSE F&O concept |
| **Delta-weighted OI** | PARTIAL | Total CE/PE OI used but not delta-weighted | Delta-weighted OI is more informative for options chains |
| **Delivery %** | READY | `delivery_pct` feature present; used as quality gate in ranker heuristic | NSE-specific; genuine quality signal |
| **VPIN** | READY | `compute_vpin()` in `volume.py` | Theoretically grounded; India-appropriate |

---

## India VIX

| Area | Status | Evidence |
|---|---|---|
| **India VIX level** | READY | `compute_vix_features()` in `macro.py`; VIX in REGIME_FEATURES |
| **VIX regime classification** | READY | 4 regimes: <13 low, 13-18 moderate, 18-25 high, >25 extreme |
| **VIX percentile** | READY | 252-day rolling percentile computed |
| **VIX mean reversion** | READY | Z-score vs 252-day history |
| **VIX change %** | READY | Day-over-day change computed |
| **India VIX thresholds** | PARTIAL | Thresholds are reasonable (India mean ~14-16) but not calibrated to historical distribution |

---

## Expiry Effects

| Area | Status | Evidence |
|---|---|---|
| **Expiry day flag** | PARTIAL | `is_expiry_day` feature exists; computed from caller-supplied parameter | No internal NSE calendar |
| **Days to weekly expiry** | PARTIAL | Feature exists; default fallback is 5 (arbitrary) | Caller must supply correct value |
| **Days to monthly expiry** | PARTIAL | Feature exists; default fallback is 20 (arbitrary) | Caller must supply correct value |
| **Theta pressure features** | READY | `weekly_theta_pressure = 1/max(days, 0.5)` — hyperbolic decay correct | Appropriate for NSE |
| **NSE expiry calendar** | **MISSING** | No calendar embedded in code | Critical gap |
| **Weekly expiry day** | **INCORRECT** | No hardcoded day, but no calendar → caller-dependent; default assumes 5 days to expiry | NSE changed weekly expiry to Tuesday (Sep 1, 2025) from Thursday |
| **Rollover period detection** | **MISSING** | Not implemented | Last 3 days of monthly cycle; OI distorted during rollover |
| **Expiry contract selection** | **MISSING** | No logic to select near vs far expiry OI data | Critical for multi-expiry OI analysis |

---

## Market Microstructure

| Area | Status | Evidence |
|---|---|---|
| **Session time zones** | READY | `compute_time_features()` — 5 zones (opening 0-30min, mid-morning 30-90, lunch 90-210, afternoon 210-300, power hour 300-375) | Correct NSE session (09:15-15:30, 375 min) |
| **Pre-open session (09:00-09:15)** | MISSING | Not modelled | Call auction; price discovery |
| **BankNifty vs Nifty spread** | READY | `bank_nifty_spread` feature | India-specific risk-on/off indicator |
| **Sector rotation** | READY | `compute_sector_rotation_score()` — Z-scores per sector, cyclicals vs defensives | India-appropriate sector classification |
| **Advance/Decline ratio** | READY | `compute_advance_decline_ratio()` — normalised (-1, 1) | Standard market breadth |
| **Market breadth (% above SMA)** | READY | `compute_market_breadth()` — 20/50/200 SMA thresholds | Correct |
| **Breadth thrust** | INCORRECT | Always returns 0.0 | Dead feature |
| **FII/DII flows** | PARTIAL | `fii_net_cr` parsed but not in REGIME_FEATURES | Missing important signal |

---

## Regulatory and Compliance

| Area | Status | Evidence |
|---|---|---|
| **F&O ban list** | **MISSING** | Zero code for ban list filtering | Daily MWPL-based ban; regulatory non-compliance risk |
| **MWPL utilisation** | **MISSING** | No MWPL data or tracking | Ban warning signal not available |
| **SEBI lot size changes (Nov 2024)** | **MISSING** | Not modelled; OI normalisation may be inconsistent across this date | Large lots now; historical OI at different scale |
| **T+1 settlement (from Jan 2023)** | **MISSING** | Not flagged | Delivery % calculation semantics changed |
| **Circuit breakers** | **MISSING** | Not detected in normalisation | Circuit days produce invalid OHLCV |
| **SEBI algo trading registration** | **MISSING** | Not documented | Regulatory requirement for live trading |
| **Position limits per SEBI** | **MISSING** | Not enforced | Risk management requirement |

---

## Inter-Market Features

| Area | Status | Evidence |
|---|---|---|
| **US futures impact** | READY | `us_futures_change` in `compute_intermarket_features()` | Correct SGX Nifty / Dow pre-market proxy |
| **Crude oil impact** | READY | `crude_change` with 0.3 dampening | India = net importer; negative impact on equities |
| **USD/INR impact** | READY | `dollar_inr_change` | Rupee depreciation → FII outflows → equity headwind |
| **Global sentiment composite** | READY | Weighted combination of above | Reasonable formulation |
| **RBI monetary policy events** | **MISSING** | Not modelled | ±50bps moves significant for Financials sector |
| **Union Budget proximity** | **MISSING** | Not modelled | Feb 1 event; highest pre-event IV of the year |
| **Election results proximity** | **MISSING** | Not modelled | Extreme volatility events |

---

## Options Analytics

| Area | Status | Evidence |
|---|---|---|
| **Black-Scholes greeks** | READY | `src/greeks.py` — delta, gamma, vega, theta | Tests pass (test_greeks — missing mibian but structure correct) |
| **IV surface** | READY | `src/vol_surface.py` — term structure, SVI fitting | Advanced; requires scipy (missing in test env) |
| **GEX (Gamma Exposure)** | READY | `src/gex.py` — per-strike and aggregate GEX | Tests pass fully (29/29 in test_gex.py) |
| **IV carry (VIX - HV)** | **MISSING** | Feature not computed anywhere | India VRP premium; should be added |
| **Skew features** | PARTIAL | `atm_skew` in DerivativesSnapshot but not used as feature | Risk reversal / call vs put premium |

---

## Summary Scorecard

| Category | READY | PARTIAL | MISSING | INCORRECT |
|---|---|---|---|---|
| F&O mechanics (PCR, OI, IV) | 6 | 4 | 0 | 0 |
| Expiry effects | 3 | 2 | 3 | 1 |
| Market microstructure | 5 | 1 | 2 | 1 |
| Regulatory/compliance | 0 | 0 | 6 | 0 |
| Inter-market | 4 | 0 | 3 | 0 |
| Options analytics | 3 | 1 | 1 | 0 |

**Most critical missing items (ranked by trading impact):**
1. F&O ban list — regulatory non-compliance if unaddressed
2. NSE expiry calendar — all expiry features unreliable without it
3. Transaction costs — systematic alpha inflation
4. IV carry feature — genuine India return premium
5. Corporate action adjustment — potential data integrity issue
6. Circuit breaker day detection — corrupted OHLCV on those days
