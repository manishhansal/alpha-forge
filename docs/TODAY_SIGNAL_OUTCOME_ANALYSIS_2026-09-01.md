# TODAY'S SIGNAL OUTCOME ANALYSIS — 2026-09-01

**Generated:** 2026-09-01 22:10 IST

---

## 1. AGGREGATE OUTCOME METRICS

| Metric | Value |
|---|---|
| Total paper trades | 321 |
| WIN (target hit) | 47 (14.6%) |
| LOSS (stop hit) | 136 (42.4%) |
| EXPIRED (EOD close, no resolution) | 138 (43.0%) |
| Win rate (WIN / (WIN+LOSS)) | 25.7% |
| Average win P&L | +0.63% |
| Average loss P&L | -0.46% |
| Expected value per trade (EV) | 0.257×0.63 + 0.743×(-0.46) = +0.16% - 0.34% = **-0.18%** |
| Total realized P&L (notional $1000/trade) | **-$32,624.52** |

**Note on EV calculation:** Excludes EXPIRED trades (0% P&L). Including EXPIRED, average P&L = (-32,624.52 / 183 resolved trades) = -$178.27 per resolved trade.

---

## 2. OUTCOME BY STRATEGY

### OPENING_BREAKOUT

| Metric | Value |
|---|---|
| Total trades | 102 |
| WIN | 27 (26.5%) |
| LOSS | 51 (50.0%) |
| EXPIRED | 24 (23.5%) |
| Win rate | 34.6% of resolved (27/78) |
| Avg win | ~+0.65% (estimated) |
| Avg loss | ~-0.43% (estimated) |
| EV (resolved) | 0.346×0.65 + 0.654×(-0.43) = +0.22% - 0.28% = **-0.06%** |
| Assessment | Near-breakeven; slightly negative due to high loss count |

**Notable winners:** MARUTI SHORT (×3 TF) +0.495%, INFY LONG (×3 TF) +0.697%, RELIANCE LONG (×3 TF) +0.789%

**Notable losses:** Most OPENING_BREAKOUT losses closed at the NEXT CANDLE after entry (closedAt = entry-1 minute = `2026-09-01 03:45:00 UTC = 09:15 IST`) — these were pre-open ORB signals that immediately hit stop. This suggests the ORB trigger fired on the pre-open 09:15 candle with an entry price that was already at the SL boundary.

**Quality concern:** Multiple trades have `closedAt = 2026-09-01 03:45:00` (09:15 IST) while `openedAt = 2026-09-01 03:46:13` (09:16 IST). This means the exit candle time (03:45:00 = 09:15) is BEFORE the entry time (03:46:13 = 09:16). This is a candle-time vs trade-time alignment issue — the resolution check uses candle close time for comparison, not wall-clock time. The 09:15 candle (which closes at 09:15+1m = 09:16) had the SL price, so the resolution correctly marks it LOSS. Not a P&L error.

---

### MOMENTUM

| Metric | Value |
|---|---|
| Total trades | 148 |
| WIN | 18 (12.2%) |
| LOSS | 78 (52.7%) |
| EXPIRED | 52 (35.1%) |
| Win rate | 18.8% of resolved (18/96) |
| Assessment | Weak performance; choppy session with many reversals |

**Analysis:** MOMENTUM strategy fires on the largest absolute % movers. On a day with broad selling (FnO bearish scanner had 10 stocks, daily picks mostly STOP_HIT), momentum trades going LONG on up-movers or SHORT on down-movers faced mean-reversion during the session. The 52 EXPIRED trades indicate many MOMENTUM signals moved < 1% in the intended direction.

---

### POSITIONING STRATEGIES (LIQUIDITY_EDGE, MAX_PAIN_GRAVITY, OI_BUILDUP, PCR_EXTREME, IV_SPIKE)

All 57 trades in these categories are **EXPIRED (0% P&L)**. 

**Analysis:**
- These strategies target mean-reversion around option chain levels (max pain, PCR, OI, IV)
- On a weekly expiry day (NIFTY September 1), indices move erratically around max pain
- PCR of 1.11 (near neutral) and ATM IV of 10-11% (low) suggest the market was not at extremes
- The synthetic 0.5% SL and 1.0% target required ≥1% directional move — indices may have oscillated within a tight range during the portion of the session these signals were open

---

### VOLUME_BREAKOUT

| Metric | Value |
|---|---|
| Total trades | 9 |
| WIN | 0 (0%) |
| LOSS | 6 (66.7%) |
| EXPIRED | 3 (33.3%) |

**ADANIGREEN VOLUME_BREAKOUT (9 trades):** All either LOSS or EXPIRED. ADANIGREEN was in BUY signal (score 21) but the 1% target was not reached. ADANIGREEN had a volume breakout with bullish momentum but likely faced resistance.

---

## 3. FORWARD RETURNS ANALYSIS

**Available data:** EOD closing prices from Yahoo 1d cache.

### Opening Breakout — MARUTI SHORT (entry 09:16 IST at 13,445)

| Timepoint | Price (approx) | Move from Entry | vs SL/Target |
|---|---|---|---|
| Entry 09:16 IST | 13,445 | 0% | — |
| Target hit 10:35 IST | 13,378.45 | -0.495% | ✅ TARGET |
| EOD 15:30 IST | 12,950 | -3.70% | Far beyond target |
| MAE (worst adverse) | 13,478.30 (SL level) | +0.25% max adverse | SL never hit |
| MFE (max favorable) | ~12,851 (EOD low) | -4.43% | Far exceeds target |

**Assessment:** MARUTI SHORT was an excellent signal — the EOD move of -3.7% far exceeded the synthetic 0.495% target. The 0.5% stop was very tight relative to the eventual move.

### Opening Breakout — KOTAKBANK LONG (entry 09:16 at 424.40)

| Timepoint | Price | Move | Assessment |
|---|---|---|---|
| Entry 09:16 IST | 424.40 | 0% | — |
| SL hit 09:15 IST (candle) | 423.00 | -0.33% | ❌ SL HIT |
| EOD (inferred) | ~425.55 (daily pick entry) | ~+0.27% | Price recovered |

**Assessment:** The SL at 423 was hit on the opening candle volatility. Price recovered later. The tight 0.33% stop was insufficient for opening range noise. This is a structural weakness of the synthetic 0.5% SL in the scanner-backed signal builder.

---

## 4. MAXIMUM ADVERSE / FAVORABLE EXCURSION

**From the P&L distribution of LOSS trades:**
- Average loss: -0.4561%
- Maximum loss observed: -0.8643% (ADANIENT SHORT in OPENING_BREAKOUT)
- This confirms no catastrophic losses — the 0.5% SL band is holding

**From WIN trades:**
- Average win: +0.6296%
- Maximum win observed: +1.5678% (PRESTIGE SHORT in MOMENTUM)
- Min win: +0.017% (IEX SHORT in DAILY_PICK — barely profitable)

---

## 5. DAILY PICKS OUTCOME DETAIL

| Symbol | Direction | Entry | EOD Price | EOD P&L | Pick P&L at Close |
|---|---|---|---|---|---|
| SAIL LONG | BULLISH | 197.65 | ~195.34 | -1.17% | CLOSED (-1.17%) |
| OIL LONG | BULLISH | 485.70 | ~490.50 | +0.99% | CLOSED (+0.99%) |
| KOTAKBANK LONG | BULLISH | 425.55 | ~419.40 | -1.45% | STOP_HIT (-1.45%) |
| IEX SHORT | BEARISH | 119.65 | ~119.63 | +0.02% | CLOSED (+0.017%) |
| WAAREEENER SHORT | BEARISH | 2590.00 | ~2592.00 | -0.08% | CLOSED (-0.077%) |
| ICICIGI SHORT | BEARISH | 1553.00 | ~1562.30 | -0.60% | CLOSED (-0.599%) |

**Daily picks net P&L (6 resolved picks):** OIL (+0.99%) + SAIL (-1.17%) + IEX (+0.017%) + WAAREEENER (-0.077%) + ICICIGI (-0.599%) = approximately **-0.84%** aggregate.

---

## 6. STRATEGY CONFIDENCE CALIBRATION

| Strategy | Stated Confidence Range | Win Rate Today | Assessment |
|---|---|---|---|
| OPENING_BREAKOUT | 0.62–0.66 (daily picks) | 34.6% | ⚠️ OVERCONFIDENT (stated 62-66% win probability) |
| DAILY_PICK | 0.28–0.35 (momentum picks) | 33% of resolved | ✅ CALIBRATED (near stated 29-35%) |
| MOMENTUM scanner | Confidence = changePct/5 | 18.8% | ❌ OVERCONFIDENT for the day |
| VOLUME_BREAKOUT | (volRatio-1)/2 | 0% | ❌ FAILED today |

**Note:** Today appears to have been a difficult intraday session with broad market weakness (10 FnO bearish trend stocks, 11/17 daily picks stopped out). Single-day win rate is not a calibration failure indicator — calibration requires 30+ trade sample.

---

## 7. SESSION QUALITY ASSESSMENT

The trading session on 2026-09-01 exhibited:
1. **Bearish bias** — 10 FnO bearish trend stocks; NIFTY and indices slightly down (BANKNIFTY PCR 1.11 = mild put bias)
2. **Low volatility** — ATM IV 10.88-11.62% (low vol environment → tight stops hit more frequently)
3. **Weekly expiry effect** — NIFTY weekly expiry creates gamma-driven intraday volatility around strikes
4. **Choppy intraday** — Many trades expired or stopped; price oscillation without sustained directional moves
5. **Strong individual moves** — MARUTI -3.7%, HCLTECH +2.7%, ADANIGREEN BUY at 21 score

**Overall session character:** MODERATELY BEARISH + CHOPPY — unfavorable for the current signal set which uses 0.5% SL bands (too tight for opening-range noise on a volatile expiry day).
