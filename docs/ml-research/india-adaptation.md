# AlphaForge ML — India-Specific Adaptation Guide

**Date:** 2026-09-06  
**Scope:** All architecture, methodology, and framework recommendations specifically adapted for Indian equity and F&O markets.

---

## 0. Critical Immediate Issue: NSE Expiry Day Change

**NSE moved all F&O expiry from Thursday to Tuesday effective September 1, 2025.**

AlphaForge's codebase hardcodes Thursday expiry assumptions in multiple places:
- `compute_expiry_features()` in `macro.py` does not embed any expiry calendar; callers must supply `days_to_weekly_expiry`
- Documentation, heuristic thresholds, and inter-system communication all assume Thursday
- `is_expiry_day` flags will be wrong for any system using a hardcoded Thursday calendar

**This is a bug in production feature generation, not just research. Fix immediately.**

The current NSE expiry schedule (as of September 2025):
```
NSE weekly: Tuesday
BSE weekly: Thursday (unchanged)
Monthly: Last Tuesday of the month (NSE)
```

**Action required:**
```python
# Replace any hardcoded day references with:
NSE_WEEKLY_EXPIRY_DAY = 1  # Tuesday (0=Monday, 1=Tuesday, ...)

def is_nse_expiry_week(date: pd.Timestamp) -> bool:
    """Returns True if date is within the weekly expiry week."""
    # Current contract expires on the Tuesday of this week
    expiry_tuesday = date - pd.Timedelta(days=date.weekday() - 1)
    return date.weekday() == 1  # is Tuesday

# Or use an actual NSE expiry calendar
NSE_EXPIRY_DATES = pd.date_range(
    start="2025-09-02",
    periods=52,
    freq="W-TUE"  # Weekly Tuesdays
)
```

---

## 1. India-Specific Data Characteristics

### 1.1 NSE F&O Universe Dynamics

The NSE F&O universe is not static — it changes quarterly based on SEBI/NSE eligibility criteria:
- Stocks enter the F&O list based on: market cap, trading volume, deliverable volume, public float
- Stocks exit (or are put in ban) based on: OI exceeding 95% of MWPL, corporate actions, delistings
- The quarterly revision typically happens in the last week of January, April, July, October

**Implication for AlphaForge:** The `TRAINING_UNIVERSE` (50 symbols) must be reconstructed historically to include only stocks that were F&O-eligible at each historical training date. Using today's universe for a 5-year backtest introduces survivorship bias — companies that were added to the F&O list recently (or that became large enough to enter) will show better historical characteristics than randomly selected stocks.

### 1.2 NSE Trading Calendar

India-specific public holidays that close NSE:
- Republic Day (Jan 26), Holi (Feb/Mar), Good Friday (Mar/Apr), Dr. Ambedkar Jayanti (Apr 14), Maharashtra Day (May 1), Independence Day (Aug 15), Ganesh Chaturthi (Aug/Sep), Dussehra (Oct), Diwali (Muhurat Trading — 1 hour only), Diwali Laxmi Puja, Gurunanak Jayanti (Nov), Christmas (Dec 25)

**Holiday effects:** The trading day before a long weekend in India consistently shows:
- Higher-than-average volume (position squaring)
- Elevated IV (uncertainty premium for multi-day gap)
- Wider bid-ask spreads (liquidity providers reduce risk)

These patterns are learnable features. Add `days_to_holiday` and `is_pre_holiday` as features.

### 1.3 F&O Roll Cycle and OI Distortions

During the last 3-4 trading days of a monthly expiry cycle:
1. Long-dated OI (next month) increases rapidly as positions are rolled
2. Near-term OI shows artificial decline (rollers closing, not new shorts)
3. PCR for the near-term contract becomes unreliable
4. Basis (futures - spot spread) widens significantly

**Feature correction needed:**
- Separate "current expiry OI" from "next expiry OI" in PCR calculation
- Flag "rollover period" (last 3 trading days of expiry cycle) as a distinct feature
- Suppress PCR signal weight during rollover period

### 1.4 India VIX Dynamics

India VIX (measured from Nifty options) has distinctive characteristics:
- Mean: ~14-16 (lower than VIX due to structural option writing by HNIs)
- Spikes: COVID (90), Budget days (30-40), Elections (25-35), 2008 (85)
- Seasonal: VIX tends to rise into Budget (Feb 1) and election results
- Intraday: VIX is calculated from real-time Nifty option prices; it can move ±5% intraday

**AlphaForge opportunity:** India VIX regime thresholds should be calibrated on historical Indian data, not imported from US VIX conventions. The appropriate thresholds are approximately:
- Low: VIX < 12 (rare in India; typically only post-election relief)
- Normal: VIX 12-18 (majority of trading days)
- Elevated: VIX 18-22 (pre-event, global uncertainty)
- High: VIX 22-28 (domestic stress, global contagion)
- Extreme: VIX > 28 (crisis; March 2020, 2008)

### 1.5 FII/DII Flow Data

Foreign Institutional Investor (FII) and Domestic Institutional Investor (DII) daily net buy/sell data is published by NSE/SEBI by end of day. This data is:
- Available daily, not in real-time
- A genuine leading indicator: large FII selling over 3-5 days is a statistically reliable bearish regime signal
- India-specific: FII flows respond to USD/INR and US Fed decisions in ways not captured by any Western market indicator

**Current gap:** `fii_net_cr` is in the `market_data` dict passed to `compute_regime_features()` but not in `REGIME_FEATURES` and thus never used in training.

**Action:** Add FII/DII net flow (rolling 5-day sum, normalised by average daily flow) to `REGIME_FEATURES`.

---

## 2. India F&O Microstructure Adaptations

### 2.1 The Volatility Risk Premium in NSE Options

The volatility risk premium (VRP) in Indian options is empirically robust:
```
VRP = India_VIX / 100 - realised_30d_vol
```

Positive VRP (IV > HV) is the norm: option sellers are consistently compensated. The VRP in India is structurally higher than in the US because:
1. Indian options market has high retail participation on the buy side
2. Large domestic institutions (insurance companies, mutual funds) systematically write options for income
3. The premium is highest around Budget day, Diwali, and election events

**Feature to add:** `vix_hv_spread = india_vix / 100 - realised_vol_30d`

A high VRP (VIX >> HV) suggests options are expensive — favour option-selling strategies (short straddle, iron condor). A low VRP (VIX ≈ HV) suggests implied vol is fairly priced.

### 2.2 PCR Signal Calibration for India

The standard PCR interpretation (PCR > 1.3 = bullish) requires calibration for India:
- India's PCR distribution is shifted right vs US: the median PCR in India is ~1.2-1.3 (higher than US ~0.8-1.0) due to structural put writing by HNIs
- The bullish threshold should be approximately 75th percentile of historical PCR distribution
- The bearish threshold should be approximately 25th percentile

**Action:** Compute PCR percentile (not PCR level) as the feature:
```python
def compute_pcr_percentile(current_pcr, pcr_history_252d):
    return (sum(1 for p in pcr_history_252d if p < current_pcr) / len(pcr_history_252d)) * 100
```

### 2.3 Max Pain Theory in Indian Options

The max-pain theory (price gravitates toward the strike where option writers have maximum profit at expiry) has anecdotal support in Indian markets. Institutional option writers (large banks, prop desks) actively defend their net short gamma positions near expiry.

The feature `max_pain_distance_pct` in AlphaForge is directionally correct but the effect is strongest:
- Within 3 trading days of expiry
- When open interest at the max-pain strike is very large relative to ATM OI

**Enhancement:**
```python
def compute_max_pain_pull(spot, max_pain, days_to_expiry, max_pain_oi_ratio):
    """
    Max pain pull is stronger near expiry and with high OI concentration.
    """
    distance = (max_pain - spot) / spot
    decay = 1.0 / max(days_to_expiry, 0.5)  # stronger near expiry
    concentration_boost = min(max_pain_oi_ratio / 0.30, 2.0)  # capped at 2x
    return distance * decay * concentration_boost
```

---

## 3. Regime-Specific Adaptations for India

### 3.1 India-Specific Regime Drivers

Beyond the standard VIX/breadth/change features, India has unique regime drivers:

| Trigger | Typical regime shift | Lead time |
|---|---|---|
| RBI Monetary Policy (bi-monthly) | Bullish on rate cut, bearish on rate hike | 0-2 days |
| Union Budget (Feb 1) | High uncertainty before, volatility spike after | 0-5 days |
| General Election results | Extreme volatility; 5-10% moves on result day | 0-1 days |
| US Fed decisions | Global risk-on/off; FII flow impact | 0-3 days |
| Major India corporate results (Infosys, Reliance quarterly) | Sector-specific regime shifts | Same day |
| China economic data | Metals (JSWSTEEL, HINDALCO) sector impact | Same day |
| Crude oil price (India = net importer) | Energy/inflation/currency channel | 0-5 days |

**Action:** Add event proximity features:
```python
INDIA_MACRO_EVENTS = {
    "rbi_mpc": [...],      # RBI MPC dates
    "union_budget": [...], # Budget dates
    "election_results": [...],  # Election result dates
}

def compute_event_proximity(date, event_type):
    """Days to nearest macro event."""
    event_dates = INDIA_MACRO_EVENTS[event_type]
    nearest = min(abs((date - e).days) for e in event_dates)
    return nearest
```

### 3.2 Seasonality in Indian Markets

India has documented seasonal patterns:
- **Jan-Feb:** Budget rally/uncertainty (high volatility)
- **Mar-Apr:** Corporate result season (mixed; sector-specific)
- **May-Jun:** Monsoon forecast impact (Agri, FMCG)
- **Oct-Nov:** Festive season (Consumer discretionary outperformance)
- **Dec-Jan:** FII year-end rebalancing (often selling)

**Monthly seasonality features:**
```python
def compute_seasonality_features(date):
    month = date.month
    return {
        "is_budget_month": 1.0 if month == 2 else 0.0,
        "is_result_season": 1.0 if month in [1, 4, 7, 10] else 0.0,
        "is_festive_season": 1.0 if month in [10, 11] else 0.0,
        "month_sin": np.sin(2 * np.pi * month / 12),
        "month_cos": np.cos(2 * np.pi * month / 12),
    }
```

---

## 4. SEBI Regulatory Constraints

### 4.1 2024 SEBI F&O Regulation Changes

SEBI introduced significant F&O market structure changes in late 2024:
- Increased minimum lot sizes for all contracts (effective Nov 2024)
- Higher margin requirements for short options (SPAN margins increased)
- Weekly option contracts now require upfront margins even for buyers
- Restriction on selling naked far-OTM options (for retail)

**Impact on AlphaForge:**
1. OI data post-November 2024 reflects larger lot sizes — normalise OI per crore notional, not per lot
2. PCR patterns may have shifted as some retail short-option strategies became uneconomical
3. Training data from before/after November 2024 may reflect different microstructure — consider adding a post-SEBI-2024 regime indicator

### 4.2 Position Limits and MWPL

NSE enforces Market-Wide Position Limits (MWPL) for each F&O stock:
- MWPL = 20% of non-promoter float (free-float)
- When total OI reaches 80% of MWPL: "warning" stage
- When total OI reaches 95% of MWPL: stock enters F&O ban

During ban, only closing trades are allowed. A stock in ban will show:
- Declining OI regardless of price direction (closing only)
- Distorted OI build-up signals
- Elevated IV (uncertainty about when ban lifts)

**Action required:** Filter F&O ban stocks from signal generation. NSE publishes the daily ban list at [nseindia.com/regulations](https://www.nseindia.com/regulations). This is missing in AlphaForge.

### 4.3 T+1 Settlement Impact

NSE moved to T+1 settlement for equity delivery in January 2023. This affects:
- Delivery percentage calculation (shares delivered the next day)
- Intraday vs delivery trade classification
- Carry cost for institutional portfolios

The `delivery_pct` feature in AlphaForge is computed from the data client but does not flag the pre/post-T+1 regime change. Data from before 2023 may have systematically different delivery patterns.

---

## 5. India-Specific Feature Engineering

### 5.1 Additional Features Required

| Feature | Computation | Why Important for India |
|---|---|---|
| `vix_hv_spread` | India VIX/100 - 30d realised vol | VRP premium; option selling signal |
| `pcr_percentile` | PCR rank vs 252d history | Calibrated PCR vs absolute level |
| `fii_net_5d` | Rolling 5-day FII net flow (₹ crore) | Leading regime indicator |
| `days_to_expiry_calendar` | From NSE Tuesday expiry calendar | Replace heuristic days_to_weekly_expiry |
| `is_rollover_period` | Last 3 trading days of monthly cycle | Suppress OI signals during rollover |
| `is_budget_week` | Within 5 trading days of Budget | Pre-event uncertainty premium |
| `is_election_period` | Within 10 days of election results | Extreme regime uncertainty |
| `is_fno_ban` | From NSE daily ban list | Exclude banned stocks |
| `lot_size` | NSE lot size for symbol | Position sizing constraint |
| `mwpl_utilisation` | Current OI / MWPL | Near-ban warning signal |
| `max_pain_pull` | Adjusted max-pain distance × expiry decay | Stronger near expiry |
| `iv_carry` | ATM IV - 30d HV | Volatility risk premium |

### 5.2 Bank Nifty vs Nifty Divergence

The BankNifty/Nifty spread is a genuine India-specific alpha signal:
- When BankNifty outperforms Nifty, financials (largest sector) are leading → risk-on
- When BankNifty underperforms Nifty while other sectors are positive, it signals sector stress (NPA concerns, credit events)
- The spread is highly correlated with FII buying/selling (FIIs favour financials)

Current implementation (`bank_nifty_spread` feature) is directionally correct. Enhancement:
```python
# Current
features["bank_nifty_spread"] = banknifty_change - nifty_change

# Better: Normalised rolling z-score
rolling_mean = pd.Series(historical_spreads).rolling(63).mean()
rolling_std  = pd.Series(historical_spreads).rolling(63).std()
features["bank_nifty_spread_z"] = (current_spread - rolling_mean.iloc[-1]) / rolling_std.iloc[-1]
```

---

## 6. India-Specific Model Calibration

### 6.1 Regime Frequency Distribution (Indian Market)

Based on historical NSE data (approximate):

| Regime | Frequency | Notes |
|---|---|---|
| STRONG_BULL | 12-15% of trading days | Post-election, budget relief, global risk-on |
| BULL | 25-30% | Normal uptrend periods |
| SIDEWAYS | 35-40% | Dominant regime; range-bound is India's default |
| VOLATILE | 10-12% | Pre-event, US Fed uncertainty |
| BEAR | 8-10% | Correction phases |
| CRASH | 2-3% | COVID, 2008 GFC, election shocks |

**Implication:** A regime classifier that always predicts SIDEWAYS would be correct 35-40% of the time. Any ML model must beat this trivial baseline. Class weights must be applied to prevent the model from collapsing to always-SIDEWAYS prediction.

**Recommended class weights:**
```python
class_weights = {
    "STRONG_BULL": 4.0,  # rare, high value
    "BULL":        1.5,
    "SIDEWAYS":    1.0,  # dominant class; weight = 1
    "VOLATILE":    3.0,
    "BEAR":        4.0,  # rare; misclassifying this is costly
    "CRASH":       8.0,  # extremely rare; false negative is catastrophic
}
```

### 6.2 IC Seasonality in India

Information Coefficient for stock ranking signals varies by market phase. Expected IC by regime:

| Regime | Expected IC range | Rationale |
|---|---|---|
| STRONG_BULL | 0.04-0.08 | Momentum signals work well; breadth confirms |
| BULL | 0.03-0.06 | Moderate signal quality |
| SIDEWAYS | 0.01-0.03 | Mean-reversion signals marginally better |
| VOLATILE | -0.02-0.02 | Signals unreliable; noise dominates |
| BEAR | 0.02-0.05 | Momentum reversal; short-side signals work |
| CRASH | Unpredictable | Liquidity-driven; signals may invert |

**Implication for AlphaForge:** The signal should be strongly damped or abstained during VOLATILE and CRASH regimes. The abstention thresholds in `AbstentionPolicy` are reasonable for this purpose but should be calibrated on historical regime/IC data.

---

## 7. Regulatory and Compliance Considerations

### 7.1 SEBI Algorithmic Trading Regulations

SEBI requires algorithmic trading systems to:
- Be registered with the broker's risk management system
- Implement kill-switch capability (immediate order cancellation)
- Maintain detailed audit logs of every order and signal
- Limit order frequency (rate limits per second)
- Have pre-trade risk checks at the broker level (separate from ML service checks)

**AlphaForge gaps:**
1. No kill-switch implementation documented
2. No rate-limiting in the signal generation pipeline
3. No explicit SEBI-compliant audit log format

### 7.2 Reporting Requirements

F&O trading with algorithmic systems requires:
- Daily position statements reconciled against broker's records
- Monthly P&L attribution (required for proprietary trading desks)
- Annual disclosure of algorithmic strategies to SEBI (for registered entities)

### 7.3 Risk Disclosures for Retail Users

If AlphaForge signals are provided to retail users, SEBI's Investment Adviser Regulations (IAR) and Research Analyst Regulations (RAR) apply:
- Signals constitute "research" and require RA registration
- Performance claims must be substantiated with SEBI-compliant disclosures
- Forward-looking statements require explicit disclaimers

**The INSUFFICIENT_EVIDENCE finding in the ML audit means AlphaForge cannot currently make any substantiated performance claim to users.**

---

## 8. India Adaptation Priority Summary

### Fix Immediately

| Item | Impact |
|---|---|
| NSE expiry day: update to Tuesday (Sep 2025) | All expiry features are wrong for post-Sep-2025 data |
| F&O ban list filtering | Trading banned stocks is regulatory non-compliant |
| NSE transaction cost model | All labels and backtest performance are overstated |

### Add Before Model Training

| Item | Impact |
|---|---|
| `vix_hv_spread` (IV carry) | Robust India-specific return premium |
| `pcr_percentile` | Calibrated PCR signal |
| `fii_net_5d` | Leading FII flow indicator |
| `is_rollover_period` | Suppresses OI noise during roll |
| Class weights for regime model | Prevents always-SIDEWAYS prediction |

### Add Before Production

| Item | Impact |
|---|---|
| NSE F&O expiry calendar (complete) | Correct expiry proximity features |
| Point-in-time universe membership | Eliminates survivorship bias |
| MWPL utilisation feature | Near-ban warning signal |
| SEBI algorithmic trading compliance | Regulatory requirement |
| Event proximity features (Budget, elections, RBI) | Macro event regime signals |
| T+1 settlement regime flag | Data consistency pre/post-2023 |
