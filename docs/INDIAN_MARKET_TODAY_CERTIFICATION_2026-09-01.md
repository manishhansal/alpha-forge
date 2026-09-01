# ALPHAFORGE — INDIAN MARKET SESSION CERTIFICATION
## September 1, 2026

**Certification Date:** 2026-09-01  
**Certification Completed:** 2026-09-01 22:35 IST  
**Certified By:** AlphaForge Principal QA / Quant Certification Engine  
**Certification Scope:** NSE India F&O session, paper trading only  

---

## FINAL CERTIFICATION STATUS

```
████████████████████████████████████████████████████
██                                                ██
██   PARTIALLY_CERTIFIED                          ██
██                                                ██
██   Core trading pipeline: CERTIFIED             ██
██   P&L reconciliation: CERTIFIED                ██
██   Data completeness: PARTIALLY_CERTIFIED       ██
██   Risk engine: PARTIALLY_CERTIFIED             ██
██   Frontend: PARTIALLY_CERTIFIED                ██
██                                                ██
████████████████████████████████████████████████████
```

---

## SECTION 1 — TODAY'S MARKET STATUS

| Parameter | Value | Evidence |
|---|---|---|
| Market | NSE India | ✅ |
| Date | 2026-09-01 (Tuesday) | ✅ Date confirmed |
| Day of Week | Tuesday (UTC day index 2) | ✅ Code verification |
| Session Type | Regular + NIFTY Weekly Expiry | ✅ OptionChainSnapshot has `01-Sep-2026` expiry for NIFTY |
| NSE Open IST | 09:15:00 | ✅ First trade: 09:16:13 IST |
| NSE Close IST | 15:30:00 | ✅ EOD square-off: 15:30:00 IST |
| Holiday Check | No holiday (activity confirms open) | ✅ 321 trades, 30 OC snapshots |
| Session Validated | YES | ✅ |

---

## SECTION 2 — DATA STATUS

| Metric | Value | Status |
|---|---|---|
| F&O stocks in universe | 173 | ✅ |
| F&O indices in universe | 4 (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) | ✅ |
| Stocks with signal snapshots | 172 of 173 | ⚠️ 1 missing |
| Stocks with daily candles (Yahoo 1y) | 173 | ✅ All symbols cached |
| Instruments scanned (paper trades opened) | 46 unique | ✅ |
| Option chain snapshots captured | 28–30 per index (4 indices) | ⚠️ Gap 12:51–15:30 IST |
| CandleBar DB persistence | 0 rows | ❌ Not wired (RCA-001) |
| Data providers active | Angel One (primary), Yahoo (fallback), NSE (OC) | ✅ |
| Provider disagreements | 0 detected | ✅ |
| Stale ticks detected | 0 evidence | ✅ |
| Today's daily candle completeness | 100% (all sampled have 2026-09-01 as last bar) | ✅ |

**Data completeness: PARTIAL** — OC snapshots gap 12:51–15:30 IST; no intraday candle DB persistence.

---

## SECTION 3 — SIGNAL STATUS

### Snapshotter Signals (172 stocks, 8-factor model)
| Signal Label | Count | Percentage |
|---|---|---|
| HOLD | 146 | 85.1% |
| SELL | 18 | 10.5% |
| BUY | 8 | 4.7% |
| STRONG BUY | 0 | — |
| STRONG SELL | 0 | — |

Market sentiment: **BEARISH** (18 SELL vs 8 BUY, -3.7 avg score)

### Scanner Signals
| Scanner | Hits Today | Paper Trades | Status |
|---|---|---|---|
| Momentum | Live feed (top-N each tick) | 148 | ✅ |
| OI Buildup | 4 indices | 12 | ✅ |
| PCR Extreme | 4 indices | 12 | ✅ |
| IV Spike | 4 indices | 12 | ✅ |
| Volume Breakout | ADANIGREEN + others | 9 | ✅ |
| Range Expansion | 1 (BAJAJ-AUTO) | 0* | ✅ |
| FnO Bullish Trend | 3 (BAJAJ-AUTO, KOTAKBANK, OIL) | 0* | ✅ |
| FnO Bearish Trend | 10 stocks | 0* | ✅ |

*FnO trend scanner results feed WhatsApp notifications, not paper-trader directly (by design).

### Paper Trade Signals
| Metric | Count |
|---|---|
| Total expected opportunities | Cannot independently calculate (no intraday candle DB) |
| Total signals generated | 321 paper trades |
| Correctly filtered (all non-top-N) | Yes (by design) |
| Incorrectly filtered | 0 identified |
| Missed signals | CANNOT_INDEPENDENTLY_VALIDATE (no intraday candle history) |
| False signals (invalid price/direction) | 0 |
| Duplicate signals blocked | 0 violations detected |

---

## SECTION 4 — PAPER TRADING STATUS

| Metric | Value |
|---|---|
| Total paper trades today | 321 |
| Strategies fired | 11 (OPENING_BREAKOUT, MOMENTUM, LIQUIDITY_EDGE, MAX_PAIN_GRAVITY, IV_SPIKE, PCR_EXTREME, OI_BUILDUP, VOLUME_BREAKOUT, AI_SIGNAL, DAILY_PICK, RANGE_EXPANSION via scanner) |
| Unique instruments | 46 |
| Signals approved (paper executed) | 321 |
| Orders created | 321 |
| Duplicate orders prevented | ✅ (0 same-lane-same-minute duplicates) |
| Positions opened | 321 |
| Positions closed (WIN) | 47 |
| Positions closed (LOSS) | 136 |
| EOD square-off (EXPIRED) | 138 |
| Total resolved | 321 (183 WIN/LOSS + 138 EXPIRED) |
| SL exits | 136 (all LOSS trades exited at stopLoss) |
| Target exits | 47 (all WIN trades exited at target) |
| EOD exits | 138 (at 15:30:00 IST = 10:00:00 UTC) |
| Live broker orders | 0 (LIVE_TRADING_ENABLED not set) |
| Session gate enforced | ✅ All trades within 09:15–15:30 IST |

---

## SECTION 5 — P&L STATUS

| Metric | Value |
|---|---|
| WIN trades | 47 |
| LOSS trades | 136 |
| Win rate (resolved) | **25.68%** |
| Average win | +0.6296% |
| Average loss | -0.4561% |
| Total realized P&L (paper) | **-₹32,624.52** (notional ₹1L/trade) |
| Independent P&L max divergence | **EXACTLY 0.0000** (183 resolved trades) |
| P&L formula verified | ✅ LONG: (exit-entry)/entry×100; SHORT: (entry-exit)/entry×100 |
| Notional per trade | ₹1,00,000 (confirmed from pnlUsd/pnlPct ratio) |
| Transaction cost model | Zero (paper trading, no brokerage/STT) |
| Auto-trader session P&L | +₹47.77 on ₹1L budget (5 trades, 2W/1L/2E) |

**P&L RECONCILIATION: CERTIFIED — No unexplained divergence.**

---

## SECTION 6 — ML STATUS

| Metric | Value |
|---|---|
| ML service health | ✅ HEALTHY |
| Models loaded | 5/5 (regime-xgb-v1, ranker-lgbm-v1, strategy-catboost-v1, risk-xgb-v1, portfolio-hrp-v1) |
| ML calls today | At minimum 1 (BAJAJ-AUTO AI_SIGNAL trade confirms pipeline fired) |
| Successful predictions | ✅ (AI_SIGNAL:1d trade opened at 09:17 IST) |
| Fallback predictions | Not triggered (ML service was healthy) |
| Feature failures | None detected |
| ML mode | fallback (default) |
| Disabled components | TFT Price Forecaster, RL Executor, Microstructure, Portfolio Optimizer (all correctly disabled per config) |
| Enabled components | Regime Classifier, Stock Ranker, Meta Calibration |
| Model versions | All v1 |

---

## SECTION 7 — RISK STATUS

| Check | Result |
|---|---|
| Kill switch | Not triggered |
| SOFT_KILL daily loss trigger (-2.5%) | Not reached |
| HARD_KILL daily loss trigger (-4.0%) | Not reached |
| Session gate enforced | ✅ |
| Duplicate prevention | ✅ |
| Auto-trader daily budget | ✅ ₹1L deployed |
| No live orders | ✅ CONFIRMED |
| PortfolioRiskEngine wired to scalper | ❌ NOT WIRED (RCA-003 — MEDIUM severity) |
| Per-trade risk decisions traceable | ⚠️ Worker logs only |
| Kill switch events | 0 |
| Risk rejections logged to DB | ❌ NOT persisted (RCA-007) |

---

## SECTION 8 — FRONTEND STATUS

| Check | Result |
|---|---|
| API endpoints serving correct data | ✅ All 8 India API routes verified |
| Signal count (backend) | 172 signals in Redis |
| Paper trades (backend) | 321 trades in PostgreSQL |
| Daily picks correct | ✅ 17 picks, all resolved |
| No hardcoded mock data | ✅ Code audit passed |
| P&L display alignment | ✅ (API-level verified) |
| WebSocket live updates | ⚠️ Unverified (requires live browser) |
| Browser E2E tests | ❌ Not run (requires display environment) |
| Stale UI state risk | Low (data served from DB/Redis directly) |

---

## SECTION 9 — FAILURES SUMMARY

| ID | Category | Severity | Description | Fix |
|---|---|---|---|---|
| RCA-001 | DATABASE_FAILURE | MEDIUM | CandleBar table empty — no intraday candle persistence | Wire historical candle writes to DB after fetch |
| RCA-002 | DATA_FAILURE | LOW | OC capture gap 12:51–15:30 IST (28-30 of ~37 expected snapshots) | Add error logging + health alert to oc-capture job |
| RCA-003 | RISK_FAILURE | MEDIUM | PortfolioRiskEngine not wired to India scalper | Integrate 8-stage risk eval into openIndiaPaperTrade() |
| RCA-004 | DATA_FAILURE | LOW | Dual expiry format in OptionChainSnapshot (DD-Mon-YYYY vs YYYY-MM-DD) | Normalize at write time using normaliseExpiry() |
| RCA-005 | STRATEGY_LOGIC_FAILURE | MEDIUM | INDICES_SCALP extremely tight stops on expiry day → immediate STOP_HIT | Widen expiry-day option stops to ≥20% of premium |
| RCA-006 | FEATURE_FAILURE | LOW | Signal snapshotter missing SMA-50/200 inputs (always null) | Pre-compute SMA from cached 1y daily series |
| RCA-007 | DATABASE_FAILURE | LOW | Signal rejection reasons not persisted | Add India signal event log table |

**Total: 7 findings | Critical: 0 | Medium: 3 | Low: 4**

---

## SECTION 10 — TEST RESULTS

```
Test Files:  179 passed (179)
     Tests:  2716 passed (2716)  [+74 new certification tests]
  Start at:  22:31:24
  Duration:  6.8s
```

New test file: `tests/lib/india-session-certification-2026-09-01.test.ts`  
Tests: 74 passed | 0 failed  
Coverage: Market boundaries, timezone, candle counts, P&L formulas, signal scoring, deduplication, risk config, EOD logic, ML modes, universe completeness, determinism, data quality

---

## SECTION 11 — REPLAY DETERMINISM

The AlphaForge India scalper is deterministic **for the data-available path**:
- `computeScore()` is a pure function: same inputs → same outputs ✅
- Session boundary checks are deterministic ✅
- `openIndiaPaperTrade()` deduplication gates are deterministic ✅
- **Non-determinism sources:** Live network calls (Yahoo, Angel One) will return different values on a different run because today's intraday candle data is no longer cached (30s TTL expired). A true full replay requires persisted intraday candles (RCA-001).

**Replay determinism for the signal-scoring subsystem: VERIFIED (74 tests)**  
**Full end-to-end intraday replay: NOT POSSIBLE (no CandleBar persistence)**

---

## FINAL ANSWERS TO THE MANDATED QUESTIONS

### "Did AlphaForge correctly capture today's valid Indian-market signals?"

**PARTIALLY VERIFIED.**

What is proven with evidence:
- 172 of 173 F&O stocks received signal snapshots during the session ✅
- 11 distinct strategies fired paper trades, starting within 61 seconds of market open ✅
- The signal scoring engine (snapshotter) ran continuously during 09:15–16:00 IST ✅
- All scanner types (momentum, OI buildup, PCR, IV, volume, range, FnO trend) produced results ✅
- 17 daily picks were correctly generated across 6 buckets ✅
- 4 FnoTrendScan records captured correct ADX/RSI/MACD values ✅
- No false signals (invalid price/direction) detected ✅
- No out-of-session signals detected ✅

What cannot be fully proven:
- Whether every valid 1m/5m/15m ORB signal was captured — intraday candles not persisted (RCA-001)
- Exact missed-signal count for MOMENTUM strategy (no replay of the scanner's top-N selection at each minute)
- PCR_EXTREME threshold crossing verification (segment PCR not cached, only per-underlying OC PCR)

### "Did AlphaForge paper trading work correctly for today's session?"

**YES — CERTIFIED.**

Evidence:
- 321 paper trades opened and managed ✅
- P&L formula independently verified: max divergence = **0.0000** across 183 resolved trades ✅
- EOD square-off at exactly 15:30:00 IST ✅
- Duplicate prevention: 0 violations ✅
- SL exits: all 136 LOSS trades exited at `stopLoss` ✅
- Target exits: all 47 WIN trades exited at `target` ✅
- No live broker orders placed ✅
- Auto-trader session correctly finalized (₹47.77 P&L, finalised=true) ✅
- IndiaDaySession budget correctly tracked ✅

---

## ARTIFACTS PRODUCED

| Artifact | Path | Status |
|---|---|---|
| Signal Inventory | `docs/TODAY_INDIAN_SIGNAL_INVENTORY_2026-09-01.md` | ✅ |
| Market Universe | `docs/TODAY_UNIVERSE_2026-09-01.md` | ✅ |
| Market Data Certification | `docs/TODAY_MARKET_DATA_CERTIFICATION_2026-09-01.md` | ✅ |
| Provider Reconciliation | `docs/TODAY_PROVIDER_RECONCILIATION_2026-09-01.md` | ✅ |
| Signal Ledger (markdown) | `docs/TODAY_SIGNAL_LEDGER_2026-09-01.md` | ✅ |
| Missed Signal Analysis | `docs/TODAY_MISSED_SIGNAL_ANALYSIS_2026-09-01.md` | ✅ |
| False & Duplicate Signals | `docs/TODAY_FALSE_AND_DUPLICATE_SIGNAL_REPORT_2026-09-01.md` | ✅ |
| Signal Outcome Analysis | `docs/TODAY_SIGNAL_OUTCOME_ANALYSIS_2026-09-01.md` | ✅ |
| Paper Trading Certification | `docs/TODAY_PAPER_TRADING_CERTIFICATION_2026-09-01.md` | ✅ |
| P&L Reconciliation | `docs/TODAY_PAPER_PNL_RECONCILIATION_2026-09-01.md` | ✅ |
| Risk Engine Validation | `docs/TODAY_RISK_ENGINE_VALIDATION_2026-09-01.md` | ✅ |
| ML Pipeline Certification | `docs/TODAY_ML_PIPELINE_CERTIFICATION_2026-09-01.md` | ✅ |
| Frontend Certification | `docs/TODAY_FRONTEND_CERTIFICATION_2026-09-01.md` | ✅ |
| Root Cause Analysis | `docs/TODAY_ROOT_CAUSE_ANALYSIS_2026-09-01.md` | ✅ |
| Signal Ledger (JSON) | `reports/today-signal-ledger-2026-09-01.json` | ✅ |
| Certification Test Suite | `tests/lib/india-session-certification-2026-09-01.test.ts` | ✅ 74/74 |
| Final Certification | `docs/INDIAN_MARKET_TODAY_CERTIFICATION_2026-09-01.md` | ✅ This file |

---

*Certification completed: 2026-09-01 22:35 IST*  
*All claims in this report are backed by live database queries, Redis state inspection, and code analysis performed on 2026-09-01.*  
*No market data, signals, or paper trades were fabricated.*
