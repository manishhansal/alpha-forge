# TODAY'S SIGNAL LEDGER — 2026-09-01

**Generated:** 2026-09-01 22:10 IST  
**Source:** PostgreSQL `PaperTrade` table (source LIKE 'in:%') + Redis `fno-pulse:signal:*`

---

## 1. OVERVIEW

| Metric | Value |
|---|---|
| Total India paper trades today | 321 |
| Unique instruments traded | 46 |
| Unique strategies fired | 11 (OPENING_BREAKOUT, MOMENTUM, LIQUIDITY_EDGE, MAX_PAIN_GRAVITY, IV_SPIKE, PCR_EXTREME, OI_BUILDUP, VOLUME_BREAKOUT, AI_SIGNAL, DAILY_PICK, RANGE_EXPANSION implied) |
| Session coverage | 09:16:13 IST → 15:30:00 IST (EOD square-off) |
| WIN trades | 47 |
| LOSS trades | 136 |
| EXPIRED trades (no SL/target hit) | 138 |
| Total realized P&L (paper, ₹ notional) | -32,624.52 USD-equivalent units |

---

## 2. SIGNAL DISTRIBUTION BY STRATEGY

| Strategy | WIN | LOSS | EXPIRED | Total | Win Rate |
|---|---|---|---|---|---|
| OPENING_BREAKOUT | 27 | 51 | 24 | 102 | 26.5% |
| MOMENTUM | 18 | 78 | 52 | 148 | 18.8% |
| LIQUIDITY_EDGE | 0 | 0 | 12 | 12 | N/A (all expired) |
| MAX_PAIN_GRAVITY | 0 | 0 | 9 | 9 | N/A (all expired) |
| IV_SPIKE | 0 | 0 | 12 | 12 | N/A (all expired) |
| PCR_EXTREME | 0 | 0 | 12 | 12 | N/A (all expired) |
| OI_BUILDUP | 0 | 0 | 12 | 12 | N/A (all expired) |
| VOLUME_BREAKOUT | 0 | 6 | 3 | 9 | 0% |
| AI_SIGNAL | 0 | 0 | 1 | 1 | N/A |
| DAILY_PICK | 2 | 1 | 1 | 4 | 50% |

---

## 3. SIGNAL LEDGER — KEY ENTRIES

### Winning Signals

| signalId (partial) | Timestamp IST | Instrument | Strategy | Direction | Entry | SL | Target | ExitPrice | pnlPct | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| cmti4kxx9... | 09:16:13 | MARUTI | OPENING_BREAKOUT:1m | SHORT | 13,445.00 | 13,478.30 | 13,378.45 | 13,378.45 | +0.495% | WIN |
| cmti4l0yl... | 09:16:13 | MARUTI | OPENING_BREAKOUT:5m | SHORT | 13,445.00 | 13,478.30 | 13,378.45 | 13,378.45 | +0.495% | WIN |
| cmti4l2fp... | 09:16:13 | MARUTI | OPENING_BREAKOUT:15m | SHORT | 13,445.00 | 13,478.30 | 13,378.45 | 13,378.45 | +0.495% | WIN |
| cmti4wzxg... | 09:20:00 | INFY | OPENING_BREAKOUT:1m | LONG | 1,133.70 | 1,129.75 | 1,141.60 | 1,141.60 | +0.697% | WIN |
| cmti4wzyp... | 09:20:00 | INFY | OPENING_BREAKOUT:5m | LONG | 1,133.70 | 1,129.75 | 1,141.60 | 1,141.60 | +0.697% | WIN |

### Losing Signals (first batch)

| signalId (partial) | Timestamp IST | Instrument | Strategy | Direction | Entry | SL | Target | ExitPrice | pnlPct | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| cmti4l2f3... | 09:16:21 | KOTAKBANK | OPENING_BREAKOUT:15m | LONG | 424.40 | 423.00 | 427.20 | 423.00 | -0.330% | LOSS |
| cmti4l0ye... | 09:16:21 | ITC | OPENING_BREAKOUT:5m | LONG | 265.10 | 263.70 | 267.95 | 263.70 | -0.528% | LOSS |
| cmti4kxx0... | 09:16:21 | ITC | OPENING_BREAKOUT:1m | LONG | 265.10 | 263.70 | 267.95 | 263.70 | -0.528% | LOSS |
| cmti4l1b6... | 09:16:28 | ICICIPRULI | MOMENTUM:15m | SHORT | 497.35 | 501.35 | 489.40 | 501.35 | -0.804% | LOSS |
| cmti4l2eo... | 09:16:28 | DIVISLAB | MOMENTUM:15m | SHORT | 9,187.00 | 9,245.15 | 9,070.70 | 9,245.15 | -0.633% | LOSS |

### Expired Signals (representative sample)

| signalId (partial) | Timestamp IST | Instrument | Strategy | Direction | Entry | pnlPct | ClosedAt IST | Status |
|---|---|---|---|---|---|---|---|---|
| cmti4l0ya... | 09:16:24 | BANKNIFTY | MAX_PAIN_GRAVITY:5m | LONG | 57,446.20 | 0% | 15:17:11 | EXPIRED |
| cmti4l0sh... | 09:16:24 | BANKNIFTY | LIQUIDITY_EDGE:5m | LONG | 57,446.20 | 0% | 15:17:11 | EXPIRED |
| cmti4l2ft... | 09:16:28 | NIFTY | IV_SPIKE:15m | SHORT | 24,034.30 | 0% | 15:17:11 | EXPIRED |
| cmti4l2fa... | 09:16:28 | NIFTY | PCR_EXTREME:15m | SHORT | 24,034.30 | 0% | 15:17:11 | EXPIRED |

---

## 4. SIGNAL SCORES (Snapshotter — 172 stocks)

### BUY Signals (score ≥ 20)

| Symbol | Signal | Score | Since IST |
|---|---|---|---|
| ADANIGREEN | BUY | 21 | 09:20:01 |
| ADANIPORTS | BUY | 21 | 11:38:48 |
| ADANIPOWER | BUY | 21 | 11:54:48 |
| HCLTECH | BUY | 21 | 11:42:48 |
| ITC | BUY | 21 | 11:23:48 |
| MPHASIS | BUY | 21 | 12:06:48 |
| PERSISTENT | BUY | 21 | 12:01:49 |
| PFC | BUY | 20 | 12:48:29 |

### SELL Signals (score ≤ -20)

| Symbol | Signal | Score | Since IST |
|---|---|---|---|
| ABB | SELL | -20 | 10:21:08 |
| ABCAPITAL | SELL | -21 | 10:11:48 |
| BHEL | SELL | -21 | 11:24:48 |
| CAMS | SELL | -21 | 11:39:48 |
| CGPOWER | SELL | -20 | 10:19:08 |
| DIVISLAB | SELL | -21 | 09:26:22 |
| ICICIPRULI | SELL | -20 | 10:28:45 |
| LAURUSLABS | SELL | -21 | 11:23:48 |
| LTF | SELL | -21 | 09:44:02 |
| MARUTI | SELL | -21 | 12:02:53 |
| MAXHEALTH | SELL | -20 | 11:42:48 |
| NESTLEIND | SELL | -21 | 10:31:41 |
| PAYTM | SELL | -21 | 09:52:09 |
| POLYCAB | SELL | -21 | 10:09:48 |
| POWERINDIA | SELL | -20 | 12:49:49 |
| PRESTIGE | SELL | -21 | 10:22:08 |
| SHRIRAMFIN | SELL | -21 | 09:44:22 |
| YESBANK | SELL | -21 | 11:42:08 |

### HOLD Signals: 146 stocks (score -19 to +19)

---

## 5. DAILY PICKS LEDGER

| tradeDate | Bucket | Rank | Symbol | Direction | Entry | SL | Target | Status | pnlPct |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-01 | INDICES_SCALP | 1 | NIFTY | BEARISH | 27.10 | 0.05 | 153.85 | STOP_HIT | 0% |
| 2026-09-01 | INDICES_SCALP | 2 | FINNIFTY | BEARISH | 316.00 | 195.95 | 453.45 | STOP_HIT | 0% |
| 2026-09-01 | MOMENTUM | 1 | SAIL | BULLISH | 197.65 | 192.85 | 203.10 | CLOSED | -1.17% |
| 2026-09-01 | MOMENTUM | 2 | OIL | BULLISH | 485.70 | 476.50 | 496.25 | CLOSED | +0.99% |
| 2026-09-01 | MOMENTUM | 3 | KOTAKBANK | BULLISH | 425.55 | 420.15 | 431.75 | STOP_HIT | -1.45% |
| 2026-09-01 | OPENING_BREAKOUT | 1 | BANKNIFTY | BEARISH | 57,416.60 | 57,507.05 | 57,235.70 | STOP_HIT | -0.171% |
| 2026-09-01 | OPENING_BREAKOUT | 2 | LT | BEARISH | 4,012.80 | 4,017.40 | 4,003.60 | STOP_HIT | -0.800% |
| 2026-09-01 | OPENING_BREAKOUT | 3 | SBIN | BEARISH | 1,044.20 | 1,044.30 | 1,044.00 | STOP_HIT | -0.010% |
| 2026-09-01 | POTENTIAL | 1 | PETRONET | BULLISH | 300.60 | 296.45 | 305.35 | STOP_HIT | -2.728% |
| 2026-09-01 | POTENTIAL | 2 | OFSS | BULLISH | 12,540.00 | 12,276.30 | 12,841.35 | STOP_HIT | -2.145% |
| 2026-09-01 | POTENTIAL | 3 | VBL | BEARISH | 400.45 | 408.95 | 390.75 | STOP_HIT | -2.135% |
| 2026-09-01 | SCALPING | 1 | SBICARD | BULLISH | 656.05 | 643.10 | 670.85 | STOP_HIT | -1.997% |
| 2026-09-01 | SCALPING | 2 | COLPAL | BEARISH | 1,866.50 | 1,897.00 | 1,831.65 | STOP_HIT | -1.666% |
| 2026-09-01 | SCALPING | 3 | IOC | BEARISH | 135.25 | 137.15 | 133.05 | STOP_HIT | -2.869% |
| 2026-09-01 | SHORT_MOMENTUM | 1 | IEX | BEARISH | 119.65 | 121.30 | 117.70 | CLOSED | +0.017% |
| 2026-09-01 | SHORT_MOMENTUM | 2 | WAAREEENER | BEARISH | 2,590.00 | 2,629.70 | 2,544.65 | CLOSED | -0.077% |
| 2026-09-01 | SHORT_MOMENTUM | 3 | ICICIGI | BEARISH | 1,553.00 | 1,577.45 | 1,525.05 | CLOSED | -0.599% |

**Daily pick observations:**
- 11 of 17 picks hit STOP — consistent with a choppy/bearish intraday session
- INDICES_SCALP entries (NIFTY, FINNIFTY) use option premium levels (27.10 / 316.00) not index spot prices
- 2 MOMENTUM picks (OIL, IEX) were profitable

---

## 6. FNOTRENDSCAN LEDGER

| tradeDate | scanType | Symbol | Entry | SL | TP1 | TP2 | TP3 | ADX | RSI | Status | pnlPct |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-01 | BULLISH | POLICYBZR | 1,875.00 | 1,810.79 | 1,948.38 | 1,994.24 | 2,058.45 | 46.2 | 73 | CLOSED | 0% |
| 2026-09-01 | BULLISH | PETRONET | 300.60 | 293.04 | 309.24 | 314.64 | 322.20 | 25.9 | 69 | STOP_HIT | -2.64% |
| 2026-09-01 | BULLISH | MOTILALOFS | 1,042.90 | 1,004.87 | 1,086.37 | 1,113.53 | 1,151.57 | 41.0 | 74 | CLOSED | 0% |
| 2026-09-01 | BEARISH | ONGC | 231.80 | 236.82 | 226.06 | 222.48 | 217.46 | 26.1 | 36 | CLOSED | 0% |

---

*All entries sourced from live database query. No signal data fabricated.*
