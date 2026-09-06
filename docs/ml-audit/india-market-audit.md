# AlphaForge ML Service — India Market Audit

**Audit Date:** 2026-09-06  
**Scope:** India-specific market microstructure, F&O dynamics, regulatory requirements, and their representation in the ML pipeline

---

## 1. India NSE F&O Context

AlphaForge targets Indian NSE F&O equities — a market with specific structural characteristics that differ significantly from US or European equities:

| Characteristic | NSE F&O | Impact on ML |
|---|---|---|
| Trading hours | 09:15–15:30 IST (375 min) | Session-specific feature zones are India-specific |
| Lot sizes | Fixed per-symbol (15–1500 shares) | Portfolio weights cannot be fractional |
| Weekly expiry | Every Thursday (Bank Nifty, Nifty 50, FinNifty) | Expiry effects dominate Thursday behaviour |
| Monthly expiry | Last Thursday of month | Rollover creates OI discontinuities |
| Circuit breakers | ±20% individual stocks, ±5/10/15% index | Liquidity vanishes at circuit limits |
| STT on sell | 0.1% on equity delivery | Asymmetric cost structure |
| Margin requirements | SEBI SPAN + Exposure margins | Position limits change with VIX |
| F&O ban list | Stocks with OI >95% of MWPL | Changes daily; must be excluded from signals |

---

## 2. What the Codebase Gets Right

### 2.1 Session Time Features

`compute_time_features()` in `macro.py` correctly divides the NSE session into India-specific zones:
- Opening volatility: 0–30 min (09:15–09:45)
- Mid-morning: 30–90 min
- Lunch lull: 90–210 min
- Afternoon trend: 210–300 min
- Power hour: 300–375 min (14:15–15:30)

Cyclical encoding (sin/cos) is included for neural model compatibility. **This is well-designed.**

### 2.2 F&O Expiry Proximity

`compute_expiry_features()` produces:
- `is_expiry_day` binary flag
- `days_to_weekly_expiry`, `days_to_monthly_expiry`
- `weekly_theta_pressure = 1/max(days, 0.5)` — captures theta decay acceleration

**The hyperbolic theta pressure is appropriate.** On expiry Thursday, near-ATM options have near-zero time value and gamma exposure is extreme.

### 2.3 OI Build-up Quadrant Classification

The 4-quadrant OI buildup model (`LONG_BUILDUP / SHORT_BUILDUP / SHORT_COVERING / LONG_UNWINDING`) maps price change vs OI change to directional signals. This is a genuine F&O insight:
- Long Buildup (price↑ + OI↑): new longs entering, **bullish**
- Short Buildup (price↓ + OI↑): new shorts entering, **bearish**
- Short Covering (price↑ + OI↓): shorts exiting, **short-term bullish but weakening**
- Long Unwinding (price↓ + OI↓): longs exiting, **short-term bearish but weakening**

**This is a genuine India F&O edge.** Indian retail and institutional participants are highly active in monthly and weekly expiry positioning, making OI signals more predictive than in many other markets.

### 2.4 PCR Interpretation

The PCR scoring function in `derivatives.py`:
```python
# PCR > 1.3 → bullish (PE writers dominating → market supported)
# PCR < 0.7 → bearish (CE writers dominating → market capped)
return np.clip((pcr - 1.0) / 0.5, -1.0, 1.0)
```

This is the standard Indian options market interpretation of PCR. Indian options markets are predominantly driven by institutional and HNI option writing, so a high PCR genuinely signals strong PE writing (put selling) which is a bullish hedging posture.

### 2.5 India VIX Regime

`compute_vix_features()` uses India-specific VIX thresholds:
- VIX < 13: low (Indian markets rarely sustain VIX < 12 for long)
- VIX 13–18: moderate (typical NSE range)
- VIX 18–25: high
- VIX > 25: extreme (2020 COVID: VIX hit 90; 2008: 85)

**The thresholds are reasonable for Indian market history.**

### 2.6 Inter-Market Features

`compute_intermarket_features()` correctly models India-specific correlations:
- BankNifty vs Nifty spread (Bank sector leadership in Indian markets)
- US futures impact (SGX Nifty / Dow pre-market)
- Crude oil impact (negative for India as net importer)
- USD/INR (rupee depreciation = equity headwind for FII flows)

The composite global sentiment formula:
```python
global_sum = (us_futures or 0) - (crude or 0) * 0.3 - (dollar_inr or 0)
```
Crude gets a 0.3 dampening factor and USD/INR is subtracted — roughly correct directional influences.

---

## 3. India-Specific Gaps

### 3.1 F&O Ban List

**No handling of the NSE F&O ban list.** When a stock's OI exceeds 95% of the Market-Wide Position Limit (MWPL), it enters the F&O ban period — new positions cannot be opened. During a ban, OI data is distorted (only closing trades allowed), PCR signals are unreliable, and the stock must be excluded from signal generation.

The `TRAINING_UNIVERSE` does not exclude stocks that may have been in ban periods during the training window. This creates distorted OI signals in historical training data.

### 3.2 Rollover Dynamics

**No rollover-specific features.** In the last few days of a monthly expiry (typically Tuesday–Thursday before expiry), F&O participants roll positions from the expiring series to the next month. This creates:
- Artificial OI increase in the next month
- Suppressed current-month OI
- Widened basis (spot vs futures price)
- Elevated OI volatility

The `compute_expiry_features()` captures theta pressure but not rollover-specific OI dynamics. A "days_to_rollover_start" feature and OI-series split tracking would improve accuracy.

### 3.3 FII/DII Flow Data

`compute_regime_features()` includes `fii_net_cr` in the `market_data` dict but the `REGIME_FEATURES` list does not include it. Foreign Institutional Investor (FII) and Domestic Institutional Investor (DII) daily net buy/sell data is a genuine regime indicator in Indian markets — FII selling under rupee depreciation is a leading bear signal.

### 3.4 Delivery Percentage

`delivery_pct` is correctly included as a feature (from the data client). In NSE, delivery % (fraction of traded volume that resulted in actual delivery vs intraday squaring) is a genuine quality indicator — high delivery % with volume breakout is a strong institutional accumulation signal.

**Assessment: Feature exists and is weighted in `_compute_heuristic_score()`. Good.**

### 3.5 Lot Size Constraints

No lot-size constraint is modelled anywhere in the pipeline. NSE F&O positions must be in multiples of lot sizes:
- NIFTY: 50 units
- BANKNIFTY: 15 units
- HDFCBANK: 550 units
- etc.

A continuous position size of 7.3% portfolio weight cannot be directly traded. The execution layer must reconcile fractional weights to lot boundaries.

### 3.6 Circuit Breaker Handling

**No circuit breaker awareness.** If a stock hits a 20% circuit breaker:
- The close price is the circuit limit, not a market-clearing price
- Volume may be very low (only buyers or only sellers)
- ATR computed from such a day is misleading
- The following day's gap is extreme and should not be treated as a normal gap

`data_pipeline.py` has quality flags (SUSPICIOUS) that may catch some circuit-breaker days, but there is no explicit circuit-breaker detection in the normalisation layer.

### 3.7 T+1 Settlement Cycle

NSE moved to T+1 settlement for equities in January 2023. This changes the carry cost of positions and the delivery % calculation. Historical data before vs after the T+1 migration may have different statistical properties for delivery-based features.

### 3.8 Pre-Market Session

NSE has a pre-market session (09:00–09:15) with call auction. The gap feature `compute_gap_pct()` uses the regular market open, not the pre-market price. This is correct for most purposes, but the pre-market auction price may better represent the genuine opening sentiment.

---

## 4. Regime Calibration for India

The regime heuristic thresholds in `MarketRegimeClassifier._predict_heuristic()` use India-appropriate values:

| Threshold | Value | India Context |
|---|---|---|
| CRASH: VIX > 30 | Reasonable | NSE VIX > 30 seen in COVID, 2008, 2020 elections |
| CRASH: Nifty < -3% daily | Reasonable | Very rare (15–20 times in past decade) |
| STRONG_BULL: VIX < 13 | Slightly tight | India VIX avg ~14; < 13 is low |
| SIDEWAYS: ADX < 18 | Reasonable for daily bars | |
| PCR > 1.2 for bull confirmation | Good | High PCR = heavy put selling = institutional hedge |

**Assessment:** Thresholds are India-appropriate. They are not calibrated to historical data distributions but are reasonable starting points.

---

## 5. Market Microstructure Gaps

### 5.1 Impact Costs

The National Stock Exchange publishes "impact cost" (a liquidity measure) for F&O stocks. This is an estimate of the percentage price impact of a standard ₹1 lakh order. Stocks with high impact costs have higher effective execution costs and should receive lower position sizes.

This is not incorporated in the feature set or position sizing.

### 5.2 Open Interest in Multiple Expiries

Indian F&O markets have weekly and monthly expiries simultaneously. The current OI features aggregate across all expiries:
```python
features["pcr_oi"] = total_pe_oi / total_ce_oi
```

A more informative approach would separate current-week OI from current-month OI from next-month OI — the relative OI distribution across expiries reveals positioning patterns (e.g., heavy near-term PE buying vs far-month CE selling).

### 5.3 Nifty vs Stock-Level Signals

The model generates per-stock signals but does not account for the fact that most Indian F&O stocks have beta close to 1 and are highly correlated with Nifty. A portfolio of 20 high-scoring F&O stocks is not 20 independent bets — it is largely a leveraged Nifty position with some stock-selection alpha.

The relative strength features (`relative_strength_vs_nifty`, `sector_relative_strength`) partially address this, but there is no beta-neutralisation or tracking-error budgeting in the portfolio construction layer.

---

## 6. Regulatory Considerations

### 6.1 SEBI Regulations

- SEBI requires position limits per client in F&O — the system does not model client-level position limits.
- SEBI has capital gain tax implications for intraday vs delivery trades — tax is not modelled in returns.
- STT (Securities Transaction Tax) for F&O: 0.05% on sell (premium-based for options) — this is a meaningful cost for high-frequency strategies.

### 6.2 RBI Currency Controls

USD/INR movements affect FII flows. Large depreciations (> 1% in a day) historically trigger FII outflows. This is captured via `dollar_inr_change` in inter-market features but without explicit threshold modelling.

---

## 7. Assessment Summary

| India-Specific Element | Present | Correct | Complete |
|---|---|---|---|
| NSE session time zones | ✅ | ✅ | ✅ |
| Weekly/monthly expiry features | ✅ | ✅ | ⚠️ No rollover |
| OI buildup quadrants | ✅ | ✅ | ✅ |
| PCR interpretation | ✅ | ✅ | ✅ |
| India VIX regime | ✅ | ✅ | ✅ |
| BankNifty vs Nifty spread | ✅ | ✅ | ✅ |
| Delivery percentage feature | ✅ | ✅ | ✅ |
| F&O ban list | ❌ | N/A | ❌ |
| FII/DII flow data | ⚠️ Partial | — | ❌ Not in REGIME_FEATURES |
| Lot size constraints | ❌ | N/A | ❌ |
| Circuit breaker handling | ❌ | N/A | ❌ |
| Rollover dynamics | ❌ | N/A | ❌ |
| Corporate action adjustment | ❌ | N/A | ❌ |
| T+1 settlement impact | ❌ | N/A | ❌ |
| Transaction costs (STT etc.) | ❌ | N/A | ❌ |
| Impact costs / liquidity | ❌ | N/A | ❌ |

---

## 8. Recommendations

| Priority | Action |
|---|---|
| 🔴 CRITICAL | Add F&O ban list filtering — exclude banned symbols from signal generation and training |
| 🔴 HIGH | Add NSE transaction cost model (brokerage + STT + SEBI + stamp + exchange) |
| 🔴 HIGH | Verify corporate action adjustment for all OHLCV data (splits, bonuses, rights issues) |
| 🟡 MEDIUM | Add rollover detection features (days to next-month expiry shift in OI distribution) |
| 🟡 MEDIUM | Include FII/DII net flow in REGIME_FEATURES (already parsed, not wired) |
| 🟡 MEDIUM | Add lot-size reconciliation in portfolio and execution layers |
| 🟡 MEDIUM | Add circuit breaker detection in OHLCV normalisation (flag days where close = high or close = low AND volume is abnormally low) |
| 🟢 LOW | Add NSE impact cost as a liquidity-adjusted position size factor |
| 🟢 LOW | Separate near-term vs far-term OI in PCR calculation |
| 🟢 LOW | Add T+1 settlement regime flag (pre- and post-January 2023) |
