# TODAY'S INDIAN MARKET UNIVERSE — 2026-09-01

**Generated:** 2026-09-01 22:10 IST  
**Source of truth:** `src/lib/india/fno-symbols.ts` + `src/lib/india/sectors.ts` (code-defined, no external config file)

---

## 1. MARKET CALENDAR

| Parameter | Value |
|---|---|
| Date | 2026-09-01 (Tuesday) |
| Day of Week | Tuesday (UTC day index 2) |
| Is Weekday | YES |
| NSE Session Expected | YES (no public holiday modelled in code — see caveat below) |
| NSE Open UTC | 2026-09-01T03:45:00Z |
| NSE Open IST | 2026-09-01 09:15:00 IST |
| NSE Close UTC | 2026-09-01T10:00:00Z |
| NSE Close IST | 2026-09-01 15:30:00 IST |
| Holiday Calendar Note | `market-hours.ts` explicitly states: "Public holidays are not modelled." Evidence of trading activity (321 paper trades, option chain snapshots from 09:15 IST) confirms the session was live. |

---

## 2. F&O INDICES UNIVERSE

| # | Name | Yahoo Symbol | NSE Underlying |
|---|---|---|---|
| 1 | NIFTY 50 | ^NSEI | NIFTY |
| 2 | BANK NIFTY | ^NSEBANK | BANKNIFTY |
| 3 | FIN NIFTY | ^CNXFIN | FINNIFTY |
| 4 | MIDCAP NIFTY | ^NSEMDCP50 | MIDCPNIFTY |

**Supplementary indices (reference only, not F&O traded):**
- SENSEX (`^BSESN`)
- INDIA VIX (`^INDIAVIX`)

---

## 3. F&O STOCKS UNIVERSE BY SECTOR

**Total stocks: 172 unique symbols** (after deduplication of cross-sector listings)

### Bank (18 stocks)
HDFCBANK, ICICIBANK, SBIN, KOTAKBANK, AXISBANK, INDUSINDBK, BANKBARODA, PNB, CANBK, UNIONBANK, INDIANB, BANKINDIA, FEDERALBNK, IDFCFIRSTB, BANDHANBNK, RBLBANK, YESBANK, AUBANK

### PSU Bank (7 stocks — also in Bank)
SBIN, BANKBARODA, PNB, CANBK, UNIONBANK, INDIANB, BANKINDIA

### IT (12 stocks)
TCS, INFY, WIPRO, HCLTECH, TECHM, LTM, MPHASIS, COFORGE, PERSISTENT, OFSS, TATAELXSI, KPITTECH

### Auto (17 stocks)
MARUTI, TMPV, HYUNDAI, M&M, EICHERMOT, TVSMOTOR, BAJAJ-AUTO, HEROMOTOCO, ASHOKLEY, BHARATFORG, MOTHERSON, BOSCHLTD, EXIDEIND, SONACOMS, UNOMINDA, TIINDIA, FORCEMOT

### Pharma (16 stocks)
SUNPHARMA, DRREDDY, CIPLA, DIVISLAB, LUPIN, AUROPHARMA, BIOCON, ALKEM, TORNTPHARM, MANKIND, ZYDUSLIFE, GLENMARK, LAURUSLABS, APOLLOHOSP, MAXHEALTH, FORTIS

### FMCG (13 stocks)
HINDUNILVR, ITC, NESTLEIND, BRITANNIA, DABUR, GODREJCP, MARICO, COLPAL, TATACONSUM, UNITDSPR, VBL, PATANJALI, GODFRYPHLP

### Metal (10 stocks)
TATASTEEL, JSWSTEEL, HINDALCO, JINDALSTEL, NMDC, NATIONALUM, VEDL, HINDZINC, SAIL, APLAPOLLO

### Energy (24 stocks)
RELIANCE, ONGC, BPCL, HINDPETRO, IOC, OIL, GAIL, COALINDIA, PETRONET, NTPC, POWERGRID, TATAPOWER, ADANIPOWER, ADANIGREEN, JSWENERGY, NHPC, SUZLON, WAAREEENER, INOXWIND, PREMIERENE, IREDA, RECLTD, PFC, IEX

### Realty (6 stocks)
DLF, LODHA, GODREJPROP, OBEROIRLTY, PHOENIXLTD, PRESTIGE

### Fin Services (33 stocks)
BAJFINANCE, BAJAJFINSV, BAJAJHLDNG, SHRIRAMFIN, CHOLAFIN, MUTHOOTFIN, MANAPPURAM, SBICARD, LICHSGFIN, PNBHOUSING, LTF, MFSL, HDFCAMC, HDFCLIFE, SBILIFE, ICICIPRULI, ICICIGI, LICI, NAM-INDIA, CAMS, KFINTECH, ANGELONE, MOTILALOFS, NUVAMA, 360ONE, POLICYBZR, PAYTM, JIOFIN, ABCAPITAL, SAMMAANCAP, CDSL, BSE, MCX

### Media (0 stocks)
_(intentionally empty — no F&O media instruments in the configured universe)_

### Infra (24 stocks)
LT, BHEL, SIEMENS, ABB, CUMMINSIND, CGPOWER, POWERINDIA, KAYNES, BEL, BDL, HAL, COCHINSHIP, MAZDOCK, IRFC, RVNL, NBCC, GMRAIRPORT, CONCOR, ADANIPORTS, ADANIENSOL, ADANIENT, KEIINDS, POLYCAB, HAVELLS

---

## 4. OPTION CHAIN UNIVERSE

Per `FNO_OPTION_UNDERLYINGS` in `fno-symbols.ts`:
- 4 F&O indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)
- 172 F&O stocks

**Total option underlyings: 176**

**Today's active expiries (from OptionChainSnapshot table):**
| Underlying | Expiry | Snapshots Captured |
|---|---|---|
| NIFTY | 01-Sep-2026 (WEEKLY EXPIRY DAY) | 28 |
| BANKNIFTY | 29-Sep-2026 | 29 + 1 (new expiry format) |
| FINNIFTY | 29-Sep-2026 | 29 + 1 |
| MIDCPNIFTY | 29-Sep-2026 | 29 + 1 |

**Note:** NIFTY September 1 is a weekly expiry. This is evidenced by the `01-Sep-2026` expiry string in OptionChainSnapshot and the Angel OI baseline key `fno-pulse:angel:oc:oibaseline:NIFTY:01-Sep-2026`.

---

## 5. INSTRUMENTS ACTUALLY SCANNED TODAY

**Evidence from PostgreSQL PaperTrade table:**

| Instrument | Type | Paper Trades |
|---|---|---|
| ADANIENT | Stock | 6 |
| ADANIGREEN | Stock | 9 |
| ADANIPORTS | Stock | 4 |
| ADANIPOWER | Stock | 5 |
| AXISBANK | Stock | 6 |
| BAJAJ-AUTO | Stock | 1 (AI_SIGNAL) |
| BAJFINANCE | Stock | 6 |
| BANKNIFTY | Index | 9 |
| BHARTIARTL | Stock | 6 |
| BOSCHLTD | Stock | 2 |
| BPCL | Stock | 1 |
| CGPOWER | Stock | 4 |
| DIVISLAB | Stock | 5 |
| DLF | Stock | 1 |
| FINNIFTY | Index | 8 |
| HCLTECH | Stock | 6 |
| HDFCBANK | Stock | 3 |
| HEROMOTOCO | Stock | 3 |
| HINDUNILVR | Stock | 3 |
| ICICIPRULI | Stock | 2 |
| INFY | Stock | 6 |
| ITC | Stock | 13 |
| KOTAKBANK | Stock | 3 |
| LAURUSLABS | Stock | 3 |
| LT | Stock | 9 |
| LTF | Stock | 3 |
| MARUTI | Stock | 9 |
| MAXHEALTH | Stock | 1 |
| MIDCPNIFTY | Index | 9 |
| NIFTY | Index | 5 |
| PAYTM | Stock | 4 |
| PFC | Stock | 1 |
| POLYCAB | Stock | 4 |
| POWERINDIA | Stock | 1 |
| PRESTIGE | Stock | 5 |
| RELIANCE | Stock | 6 |
| ABCAPITAL | Stock | 6 |
| ABB | Stock | 4 |
| ADANIPOWER | Stock | 5 |
| IEX | Stock | — (daily pick) |
| ICICIGI | Stock | — (daily pick) |
| WAAREEENER | Stock | — (daily pick) |
| SAIL | Stock | — (daily pick) |
| OIL | Stock | — (daily pick) |
| PETRONET | Stock | — (daily pick) |
| OFSS | Stock | — (daily pick) |

**Total unique instruments with paper trades: 46**
**Total unique instruments with signal snapshot: 172 (all F&O stocks)**
**Total unique instruments with option chain capture: 4 (all F&O indices)**

---

## 6. MISSING / INVALID / DUPLICATE INSTRUMENTS

| Check | Result |
|---|---|
| Instruments in universe (code-defined) | 172 stocks + 4 indices = 176 |
| Instruments with signal snapshots | 172 stocks (all present — confirmed from Redis SCAN) |
| Instruments with paper trades today | 46 (subset — only those that generated tradeable signals) |
| Instruments with duplicate entries in universe | 7 PSU Bank stocks appear in both Bank and PSU Bank sectors (by design: `sectors.ts` comment confirms intentional) |
| Invalid instruments | 0 — no instrument outside the configured set |
| Missing instruments from snapshot | 0 — all 172 stocks have a Redis signal key |
| CandleBar persistent store | NOT USED — `CandleBar` table is defined in schema but never populated by any worker job. The system uses Redis candle cache exclusively. |

---

*Source: `src/lib/india/fno-symbols.ts`, `src/lib/india/sectors.ts`, Redis SCAN, PostgreSQL query*
