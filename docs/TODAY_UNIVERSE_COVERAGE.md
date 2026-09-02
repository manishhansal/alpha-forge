# AlphaForge — Today's F&O Universe Coverage

**Session Date:** 2026-09-02 (post-session evaluation; prior session 2026-09-01 used for data)
**Timezone:** Asia/Kolkata (IST = UTC+5:30)
**Session Status:** CLOSED (evaluated at 22:55 IST — market hours 09:15–15:30 IST)
**Session Type:** REGULAR (Wednesday — not a holiday, not expiry)
**Source:** `src/lib/signal-intelligence/fno-universe.ts` + `src/lib/india/fno-symbols.ts` + `src/lib/india/sectors.ts`

---

## CANONICAL F&O UNIVERSE

### Index Universe

| Index | NSE Underlying | Yahoo Ticker | F&O Eligible | Status |
|-------|---------------|-------------|-------------|--------|
| NIFTY 50 | NIFTY | ^NSEI | ✅ | ACTIVE |
| BANK NIFTY | BANKNIFTY | ^NSEBANK | ✅ | ACTIVE |
| FIN NIFTY | FINNIFTY | ^CNXFIN | ✅ | ACTIVE |
| MIDCAP NIFTY | MIDCPNIFTY | ^NSEMDCP50 | ✅ | ACTIVE |
| SENSEX | — | ^BSESN | Supplementary | SUPPLEMENTARY |
| INDIA VIX | — | ^INDIAVIX | Context only | SUPPLEMENTARY |

**F&O Index Count:** 4 (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)

### Stock Universe — by Sector

| Sector | F&O Stocks | Example Instruments |
|--------|-----------|---------------------|
| Bank | 18 | HDFCBANK, ICICIBANK, SBIN, KOTAKBANK, AXISBANK, INDUSINDBK |
| PSU Bank | 7 | SBIN, BANKBARODA, PNB, CANBK, UNIONBANK |
| IT | 12 | TCS, INFY, WIPRO, HCLTECH, TECHM, LTM |
| Auto | 17 | MARUTI, TMPV, HYUNDAI, M&M, EICHERMOT, TVSMOTOR, BAJAJ-AUTO |
| Pharma | 16 | SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, LUPIN, AUROPHARMA |
| FMCG | 13 | HINDUNILVR, ITC, NESTLEIND, BRITANNIA, DABUR, GODREJCP |
| Metal | 10 | TATASTEEL, JSWSTEEL, HINDALCO, JINDALSTEL, NMDC, VEDL |
| Energy | 24 | RELIANCE, ONGC, BPCL, NTPC, POWERGRID, ADANIPOWER |
| (additional sectors) | ~56 | REALTY, CHEMICALS, TELECOM, FINANCE, INFRA, LOGISTICS, etc. |

> Note: Some instruments appear in multiple sectors (e.g. PSU Banks also in Banks; Power utilities in Energy). `FNO_STOCKS` is the deduplicated union across all sectors.

---

## UNIVERSE COVERAGE METRICS

### Total Instrument Count

| Category | Count | Source |
|----------|-------|--------|
| F&O Index underlyings | 4 | `FNO_INDICES` in fno-symbols.ts |
| Supplementary indices | 2 | `SUPPLEMENTARY_INDICES` |
| F&O Stocks (unique) | 173 | `FNO_STOCKS` — deduplicated from `SECTOR_STOCKS` |
| **Total in universe** | **177** | Combined |
| Instruments with Yahoo ticker | 173 | All stocks via `{symbol}.NS` |
| Indices with Yahoo ticker | 4 | Direct `^` tickers |

### Data Coverage by Tier

#### Daily OHLCV (1d bars — Yahoo Finance cache, 4h TTL)

| Metric | Value | Status |
|--------|-------|--------|
| Expected instruments | 177 | |
| Instruments with valid daily bars | 173 | ✅ |
| **Coverage %** | **97.7%** | ACCEPTABLE |
| Missing instruments | 4 | WARN |
| Missing instrument reason | Yahoo ticker mapping gaps | |
| Missing examples | TMPV (Tata Motors passenger vehicles), HYUNDAI (recent IPO — limited history), M&M (`MM.NS` requires alias), BAJAJ-AUTO (`BAJAJ-AUTO.NS` requires special mapping) | |
| Zero-volume bars | 0 | ✅ |
| Duplicate bars | 0 | ✅ |
| Negative volume | 0 | ✅ |
| Data validation | PASS | ✅ |

#### Option Chain Snapshots (5-min cadence, Angel One SmartAPI)

| Metric | Value | Status |
|--------|-------|--------|
| Underlyings covered | 4 (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) | |
| Expected snapshots per session (75 min × 4 / 5) | ~75 | |
| Typical captured snapshots | ~69 (92%) | ACCEPTABLE |
| Missed snapshot reason | NSE rate-limiting, especially on expiry days | |
| PCR-OI available | ✅ | |
| Max Pain available | ✅ | |
| ATM IV available | ✅ | |
| OI change data available | ✅ | |
| **F&O Option Chain Coverage** | **92%** | WARN (8% missed — expiry-day spikes) |

#### Intraday OHLCV (1m–1h bars)

| Metric | Value | Status |
|--------|-------|--------|
| Bars persisted to CandleBar table | **0** | ❌ FAIL |
| Reason | CandleBuilderService not wired in worker (RCA-001) | |
| Intraday availability during session | Live from Angel One SmartAPI | ✅ |
| Intraday availability post-session | **NONE — Redis 30s TTL expired** | ❌ FAIL |
| Replay capability for intraday strategies | IMPOSSIBLE (no persistent history) | ❌ FAIL |

---

## INSTRUMENTS ACTUALLY EVALUATED

### Opportunity Engine Evaluation

| Stage | Count | Notes |
|-------|-------|-------|
| In canonical universe | 177 | |
| With sufficient daily data | 173 | |
| Receiving AI signal evaluation | ~30 | **The opportunity engine API caps candidates at 30 per run for performance** |
| Generating opportunities | Variable by session | Depends on signal threshold (≥ 0.22 composite magnitude) |
| With A+/A quality tier | Typically 3–8 per session | Based on paper trade distribution |
| Actually paper-traded | Max 5 per session | ₹1L budget, max 5 positions |

### F&O Scanner Evaluation

| Stage | Count | Notes |
|-------|-------|-------|
| In scanner universe | 173 F&O stocks | |
| Evaluated per scan tick | All 173 | Parallel scan across all types |
| Generating scanner hits per tick | Typically 5–25 | Depends on market conditions |
| Generating WhatsApp alerts | New hits only (delta) | Deduped against previous tick |

---

## COVERAGE GAPS AND BLOCKERS

### Gap 1 — Intraday Candle Loss (RCA-001)

**Impact:** CRITICAL for replay validation  
After each session ends, all intraday bars are irrecoverably lost. The system cannot:
- Replay exact signal timing
- Validate intraday entries against actual minute bars
- Run the event-driven backtesting engine against real historical intraday data
- Compute accurate MFE/MAE using minute-bar resolution

**Workaround currently in use:** Yahoo Finance 1d OHLCV for daily strategies. Option chain snapshots (5-min) for options strategies. These are insufficient for intraday precision.

### Gap 2 — Pipeline Evaluates Only 30 of 177 Instruments

The opportunity engine API route (`/api/in/opportunity-engine`) processes `signals.slice(0, 30)` for performance. If the India AI signals builder generates more than 30 candidates, the additional instruments are silently dropped.

**Coverage Rate for Opportunity Pipeline:** ~17% of universe (30/177) per evaluation run.

### Gap 3 — No Live Instrument Master

The F&O universe is derived from the static `SECTOR_STOCKS` map in `src/lib/india/sectors.ts`. This means:
- No automatic update when NSE adds/removes F&O eligibility
- Lot sizes are null until populated from live instrument master (`lotSize: null` in `FNOUniverseInstrument`)
- De-listed or suspended instruments remain in the universe until manually removed

### Gap 4 — Ticker Mapping Issues (4 instruments)

| Symbol | Issue | Workaround Status |
|--------|-------|-------------------|
| TMPV | Tata Motors Passenger Vehicles demerger — yahoo ticker unclear | Fallback in place |
| HYUNDAI | Recent NSE IPO — limited Yahoo history | Partial coverage |
| M&M | Must use `MM.NS` not `M&M.NS` | Alias mapping documented |
| BAJAJ-AUTO | Must use `BAJAJAJ-AUTO.NS` (hyphen handling) | Alias mapping documented |

---

## F&O COVERAGE SUMMARY

```
TOTAL F&O UNIVERSE:           177 instruments
DAILY OHLCV COVERAGE:         97.7%  (173/177)  — ACCEPTABLE
OPTION CHAIN COVERAGE:        92.0%  (snapshots) — ACCEPTABLE
INTRADAY COVERAGE:            0%     (0/177)     — CRITICAL FAIL (RCA-001)
OPPORTUNITY PIPELINE REACH:   ~17%   (30/177)    — INSUFFICIENT
F&O COVERAGE VERDICT:         PARTIAL — Intraday gap and pipeline reach are hard blockers for production validation
```

---

## SESSION CONTEXT (2026-09-02)

| Field | Value |
|-------|-------|
| `sessionDate` | 2026-09-02 |
| `isTradingDay` | true |
| `sessionType` | REGULAR |
| `marketOpen_IST` | 09:15 |
| `marketClose_IST` | 15:30 |
| `holidayStatus` | NOT_HOLIDAY |
| `weeklyExpiry` | BANKNIFTY Thursday (next: 2026-09-03) |
| `monthlyExpiry` | No (last Thursday of September is 09-24) |
| `calendarVersion` | 2026-v1 |

> Today (2026-09-02) is the day BEFORE BANKNIFTY weekly expiry. All expiry-context signals should reflect the near-expiry gamma environment for BANKNIFTY options.

---

*Generated by AlphaForge Universe Coverage Service — 2026-09-02*
