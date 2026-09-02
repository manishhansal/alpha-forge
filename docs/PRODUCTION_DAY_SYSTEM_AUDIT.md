# AlphaForge — Production Day System Audit

**Audit Date:** 2026-09-02 (Wednesday, IST)
**Evaluation Session:** 2026-09-01 (Tuesday — last completed NSE trading session)
**Audit Type:** Phase 1 Full System Audit — 64-Phase Production Truth Validation
**Auditor:** AlphaForge Production Validation Engine
**Methodology:** Static code analysis + runtime architecture tracing + signal ledger reconciliation + data model audit

---

## LEGEND

| Symbol | Meaning |
|--------|---------|
| ✅ | IMPLEMENTED & VERIFIED |
| 🔌 | WIRED (connected to other systems) |
| ▶️ | EXECUTED (runs in production worker) |
| 🧪 | TESTED (has corresponding test suite) |
| 📊 | REAL DATA (uses real market data) |
| ⚠️ | PARTIAL / DEGRADED |
| ❌ | NOT IMPLEMENTED / NOT WIRED / NOT EXECUTED |

---

## PART 1 — SUBSYSTEM CLASSIFICATION

### 1. Signal Generation & Strategy Registry

**Status: ✅ IMPLEMENTED | 🔌 WIRED | ▶️ EXECUTED | 🧪 TESTED | ⚠️ DATA (Yahoo/Angel One)**

| Component | Status | Notes |
|-----------|--------|-------|
| `StrategyRegistry` singleton | ✅ IMPLEMENTED | 18 strategies catalogued in `STRATEGY_CATALOG` |
| Crypto scalping strategies (10) | ✅ IMPLEMENTED | UT_SMC, VWAP_SWEEP_TREND, NEWS_MOMENTUM, RANGE_SCALP, EMA_PULLBACK, VWAP_REVERSION, ORDERFLOW_SWEEP, FIB_PULLBACK, INSTITUTIONAL_SMC, AI_INSTITUTIONAL_PRO |
| India F&O strategies (7) | ✅ IMPLEMENTED | FNO_RANGE_EXPANSION, INDIA_MOMENTUM, INDIA_VOLUME_BREAKOUT, INDIA_OI_BUILDUP, INDIA_AI_SIGNALS, OPENING_BREAKOUT, DAILY_PICK_AI |
| Signal source registry | ✅ IMPLEMENTED | `src/lib/signal-intelligence/signal-source-registry.ts` |
| Strategy lifecycle status | ⚠️ PARTIAL | **ALL 18 strategies remain at `RESEARCH` or `SHADOW` status. None have been promoted through V6 research pipeline.** |

**CLASSIFICATION FINDING:** `RESEARCH_ONLY` — No strategy has achieved `BACKTEST_VALIDATED` or higher.

---

### 2. Opportunity Engine & Daily Picks

**Status: ✅ IMPLEMENTED | ⚠️ PARTIALLY WIRED | ▶️ PARTIALLY EXECUTED | 🧪 TESTED**

| Component | Status | Notes |
|-----------|--------|-------|
| `OpportunityPipelineOrchestrator` | ✅ IMPLEMENTED | `src/lib/opportunity-engine/pipeline.ts` — 12-stage pipeline |
| `OpportunityDetector` | ✅ IMPLEMENTED | `src/lib/opportunity-engine/opportunity-detector.ts` |
| `ExpectedValueEngine` | ✅ IMPLEMENTED | Full 7-component NSE F&O cost model |
| `HardGateEngine` | ✅ IMPLEMENTED | `src/lib/opportunity-engine/hard-gate-engine.ts` |
| `MarketRegimeEngine` | ✅ IMPLEMENTED | `src/lib/opportunity-engine/market-regime-engine.ts` |
| `MTFConfirmationEngine` | ✅ IMPLEMENTED | Multi-timeframe alignment scoring |
| `PositionSizingEngine` | ✅ IMPLEMENTED | Quality × EV × drawdown × regime multipliers |
| `ProbabilityCalibration` | ✅ IMPLEMENTED | Logistic shrinkage toward 50% |
| `OpportunityRanker` | ✅ IMPLEMENTED | EV × quality × liquidity ranking |
| `IndiaDailyPicks` engine + worker | ✅ WIRED & EXECUTED | Worker job registered, 60s cadence |
| API route `/api/in/opportunity-engine` | ✅ WIRED | Returns ranked `OpportunityV1[]` |
| **CRITICAL GAP — Candle data wiring** | ❌ NOT WIRED | **The API route and auto-trader pass `dailyCandles: []`, `intradayCandles: []`, `niftyDailyCandles: []` to the pipeline. All multi-timeframe analysis runs on EMPTY ARRAYS. Quality scores are computed on stub data.** |

**DEFECT ID: OPP-001**
**Severity: HIGH**
**Impact:** The 12-stage pipeline logic is correct and sophisticated but the quality scores it produces are unreliable — they are computed without real candle data. `structureScore`, `momentumScore`, `volumeScore`, regime compatibility, and MTF alignment are all defaulting to conservative heuristics without real bars.

---

### 3. AI Signals & ML Service

**Status: ✅ IMPLEMENTED | 🔌 WIRED (fail-soft) | ▶️ PARTIALLY EXECUTED | 🧪 TESTED | ❌ ML NOT TRAINED**

| Component | Status | Notes |
|-----------|--------|-------|
| `IndiaAISignalsBuilder` | ✅ IMPLEMENTED | `src/features/ai-signals/india-builder.ts` — 14-factor confluence |
| `MLEnhancedContext` (TypeScript) | ✅ IMPLEMENTED | 60s TTL cache, null fallback if ML service unreachable |
| `ml-service/src/server.py` (FastAPI) | ✅ IMPLEMENTED | Endpoints defined for all model types |
| `MarketRegimeClassifier` Python | ✅ IMPLEMENTED | Code exists; `market_regime.json` is config stub, NOT trained weights |
| `StockRanker` Python (CatBoost) | ⚠️ PARTIAL | `strategy_selector.cbm` is a real trained CatBoost artifact |
| `MetaModel` Python | ✅ IMPLEMENTED | 5 files: calibration, ensemble, abstention, decision_policy, meta_model |
| ML service running in production | ❌ NOT VERIFIED | Requires Docker or standalone Python environment. Without `ML_SERVICE_URL` reachable, all ML calls silently return `null` and the system falls back to 100% heuristic |

**CLASSIFICATION:** `REAL-LIVE-DATA: NO (ML PATH)` | `HEURISTIC-ONLY: YES`

The India AI Signals builder operates in full heuristic mode. The 65%/35% (heuristic/ML) blending in `ml-enhanced-context.ts` defaults to 100% heuristic when the ML service is unreachable. **This is not a failure — the system degrades gracefully — but it must be explicitly acknowledged.**

---

### 4. F&O Scanners

**Status: ✅ IMPLEMENTED | 🔌 WIRED | ▶️ EXECUTED | 🧪 TESTED | 📊 REAL DATA**

| Scanner Type | Status | Data Source |
|-------------|--------|-------------|
| Range Expansion (WR8) | ✅ EXECUTED | Yahoo Finance daily OHLCV |
| Momentum (top gainers/losers) | ✅ EXECUTED | Angel One SmartAPI (with creds) / Yahoo fallback |
| Volume Breakout | ✅ EXECUTED | Yahoo Finance |
| OI Buildup | ✅ EXECUTED | Angel One (with creds) / NSE chain fallback |
| PCR Extreme | ✅ EXECUTED | NSE option chain |
| IV Spike | ✅ EXECUTED | NSE option chain |
| FnO Bullish/Bearish Trend (14-condition) | ✅ EXECUTED | Yahoo Finance daily OHLCV |

Worker job `india-scanner` runs every 5 minutes. WhatsApp notifications implemented for new scanner hits. `FnoTrendScan` DB table persists results with outcome tracking.

---

### 5. Paper Trading & Auto Paper Trading

**Status: ✅ IMPLEMENTED | 🔌 WIRED | ▶️ EXECUTED | 🧪 TESTED | 📊 REAL DATA**

| Component | Status | Notes |
|-----------|--------|-------|
| India paper-trader engine | ✅ IMPLEMENTED | ATR-based sizing, NSE 0.05-tick rounding, expiry-day gamma cooldown |
| Auto-trader engine | ✅ IMPLEMENTED | Composite scoring → Opportunity Pipeline → trade open |
| Auto-trader worker job | ✅ WIRED & EXECUTED | 60s cadence, market-hours guard, runOnStart=true |
| EOD square-off job | ✅ WIRED & EXECUTED | Fires after 15:30 IST, Redis distributed lock (exactly-once) |
| `IndiaDaySession` tracking | ✅ WIRED | ₹1L daily budget, deployed capital, per-session P&L |
| `PaperTrade` DB table | ✅ WIRED | Shared table, `in:` source prefix for India trades |
| **Duplicate guard — cross-symbol** | ✅ WIRED | `db.paperTrade.findFirst({ where: { symbol, status: "OPEN" }})` |
| **Duplicate guard — cross-timeframe** | ❌ NOT WIRED | **Same signal fires across 1m/5m/15m with identical entry/exit/PnL. No deduplication at the signal-generation layer.** |

**DEFECT ID: DUP-001 (CRITICAL)**
**Evidence:** 2026-09-01 signal ledger shows MARUTI OPENING_BREAKOUT firing at identical entry (13445.0), stop (13478.3), target (13378.45), and exit (13378.45) across 3 timeframes simultaneously. 321 raw trades in the ledger likely represent ~107 unique instrument-direction signals.
**Impact:** Win rate, P&L, and paper capture statistics are 3× inflated on multi-timeframe strategies. Risk exposure is triple-counted for affected positions.

---

### 6. Risk Engine & Portfolio

**Status: ✅ IMPLEMENTED | ❌ NOT WIRED IN LIVE PATH | ❌ NOT EXECUTED (live) | 🧪 TESTED**

| Component | Status | Notes |
|-----------|--------|-------|
| `PortfolioRiskEngine` | ✅ IMPLEMENTED | `src/lib/risk/portfolio-risk.ts` — 8-step pre-trade pipeline |
| Exposure calculation | ✅ IMPLEMENTED | `src/lib/risk/exposure.ts` |
| Correlation matrix | ✅ IMPLEMENTED | `src/lib/risk/correlation.ts` |
| VaR / CVaR | ✅ IMPLEMENTED | `src/lib/risk/var.ts` |
| Drawdown classifier | ✅ IMPLEMENTED | `src/lib/risk/drawdown.ts` |
| Kill switch | ✅ IMPLEMENTED | `src/lib/research/killswitch/strategy-kill-switch.ts` |
| **Live portfolio state query** | ❌ NOT WIRED | **The auto-trader and opportunity pipeline use hardcoded `currentDrawdownPct: 0, currentExposurePct: calculated_from_session`. The `PortfolioRiskEngine` module files exist but are NOT imported or invoked in the production trading path.** |

**DEFECT ID: RISK-001 (HIGH)**
**Impact:** Position sizing decisions, drawdown halts, and correlation limits in the opportunity pipeline operate on stale/approximate portfolio state rather than live risk-adjusted values. A trader could accumulate correlated risk beyond the intended `maxPortfolioExposurePct: 80%` limit during a high-signal session.

---

### 7. Meta Decision Engine

**Status: ✅ IMPLEMENTED (Python) | 🔌 WIRED (fail-soft) | ❌ NOT EXECUTED (models not trained) | 🧪 TESTED (Python)**

The Python meta decision engine (`ml-service/src/meta/`) is fully implemented with 5 modules: calibration, ensemble, abstention, decision_policy, meta_model. It is accessible via FastAPI endpoints. However:
- `market_regime.json` is a configuration file, not trained model weights
- Without running `ml-service/train_all.py` against real NSE historical data, the `MetaModel.load()` call will fail and the system falls back to heuristic
- No evidence the ML service was running during the 2026-09-01 session

**CLASSIFICATION:** `LIVE PROVIDER CERTIFICATION = NOT EXECUTED (ML PATH)`

---

### 8. Market Data Registry & Candle Builder

**Status: ✅ IMPLEMENTED | ⚠️ PARTIALLY WIRED | ⚠️ PARTIALLY EXECUTED | 🧪 TESTED**

| Component | Status | Notes |
|-----------|--------|-------|
| `ProviderRegistry` | ✅ IMPLEMENTED | 4 providers: Angel One, Upstox, NSE direct, Yahoo |
| Angel One adapter | ✅ IMPLEMENTED | SMARTAPI credentials PRESENT in `.env.local` |
| Yahoo Finance adapter | ✅ EXECUTED | Default fallback, always active |
| NSE direct scraper | ✅ IMPLEMENTED | Cookie-warmed; brittle but functional |
| `CandleBuilderService` | ✅ IMPLEMENTED | `src/lib/market-data/services/candle-builder.service.ts` |
| `CandleBar` DB table | ✅ DEFINED | Schema exists, TimescaleDB-ready |
| **CandleBar persistence** | ❌ NOT WIRED | **CandleBuilderService is defined but NOT started in the worker bootstrap (`worker/src/index.ts`). No intraday candle bars are written to the database. Intraday data lives only in Redis with a 30-second TTL.** |

**DEFECT ID: RCA-001 (HIGH — existing documented defect)**
**Impact:** Cannot replay per-minute bar data for historical sessions. All intraday signal analysis is ephemeral — lost after each 30s Redis TTL expiry. Option-chain replay is the only persisted intraday history (5-min OptionChainSnapshot). Price-based backtests use Yahoo 1d bars only.

---

### 9. Execution Simulator & Backtesting

**Status: ✅ IMPLEMENTED | ⚠️ LIBRARY ONLY | ❌ NOT WIRED TO PRODUCTION | 🧪 TESTED (116 tests)**

| Component | Status | Notes |
|-----------|--------|-------|
| `backtesting-v2` event-driven engine | ✅ IMPLEMENTED | Full event queue, clock, risk manager, execution sim |
| NSE transaction cost model | ✅ IMPLEMENTED | 7 cost components in `ExpectedValueEngine` |
| `execution/` — 12 files | ✅ IMPLEMENTED | Slippage, partial fill, gap-through, latency models |
| Legacy crypto backtester | ✅ WIRED | `/api/scalper/backtest` route — executed |
| Legacy India F&O backtester | ✅ WIRED | Uses Yahoo 1d OHLCV; covers strategy-level signal logic |
| `backtesting-v2` API route | ❌ NOT WIRED | No API route or worker job invokes the v2 engine |

---

### 10. Worker Scheduler & Jobs

**Status: ✅ IMPLEMENTED | ✅ WIRED | ✅ EXECUTED | 🧪 TESTED**

All 14 jobs confirmed registered in `worker/src/index.ts`:

| Job | Interval | Market Guard | Status |
|-----|----------|--------------|--------|
| `liquidations` | WebSocket | No | ✅ (no-op on Delta broker) |
| `signal-ingest` | 60s | No | ✅ |
| `signal-outcome` | 300s | No | ✅ |
| `alerts` | 30s | No | ✅ |
| `scalper` (crypto) | 30s | No | ✅ |
| `india-scalper` | 60s | **Yes (09:15–15:30)** | ✅ |
| `india-oc-capture` | 300s | **Yes** | ✅ |
| `india-daily-picks` | 60s | **Yes** | ✅ |
| `india-fno-trend-track` | 60s | **Yes** | ✅ |
| `india-eod-squareoff` | 60s | **Yes (15:30+ only)** | ✅ |
| `india-auto-trader` | 60s | **Yes** | ✅ |
| `strategy-lab` | 60s | No | ✅ |
| `india-scanner` | 300s | **Yes** | ✅ |
| `heartbeat` | 60s | No | ✅ |

**WIRING GAP:** `market-hours.ts` (`isNseMarketOpenIST`) does NOT check NSE public holidays — it only checks Mon–Fri + session hours. On an NSE holiday, all India jobs with this guard will run and attempt to fetch live data, receiving stale/unchanged values. The full `NSETradingCalendar` class (with holiday awareness) is available but not used in the worker guards.

**DEFECT ID: CAL-001 (MEDIUM)**

---

### 11. Research Pipeline & Validation

**Status: ✅ IMPLEMENTED | ⚠️ PARTIALLY WIRED | ❌ NOT EXECUTED (no production data) | 🧪 TESTED (92 tests)**

- Full V6 research pipeline exists: `src/lib/research/` — 18+ subdirectories
- All 18 strategies remain at `RESEARCH` or `EXPERIMENTAL` status
- No `ExperimentRecord` has been populated with real NSE data
- Walk-forward validation, CPCV, purged K-fold, Monte Carlo, cost stress — all implemented, none executed against real data
- The signal quality dashboard (`/in/signal-quality`) computes a 20-phase report from `SignalHistory` + `PaperTrade` DB data and IS executed

---

### 12. Signal Intelligence Audit Trail

**Status: ✅ IMPLEMENTED | ❌ NOT WIRED | ❌ NOT EXECUTED**

Four DB models defined in schema: `SignalLifecycleEvent`, `UniverseCoverageSnapshot`, `OpportunityCluster`, `SignalIntelligenceRecord`.

**DEFECT ID: AUDIT-001 (HIGH)**
The in-memory `SignalLifecycleEvent` state machine (`src/lib/signal-intelligence/signal-lifecycle.ts`) tracks transitions (DETECTED → VALIDATING → QUALIFIED → RISK_CHECK → APPROVED → PAPER_EXECUTED → ACTIVE → EXITED) but **no production code writes these events to the database**. Every signal lifecycle audit trail is lost on process restart. The broken-chain analysis required by Phase 7 cannot be performed without persistent lifecycle records.

---

## PART 2 — DATA SOURCE TRUTH TABLE (2026-09-01 Session)

| Data Type | Source | Classification | Provider | Notes |
|-----------|--------|---------------|----------|-------|
| NSE daily OHLCV (all instruments) | Yahoo Finance 1y cache | CACHED (4h TTL) | yahoo-finance2 | 97.7% coverage; 4 instruments with ticker mapping issues |
| NIFTY/BANKNIFTY index levels | Yahoo Finance | CACHED | yahoo-finance2 | `^NSEI`, `^NSEBANK` |
| Option chain snapshots | Angel One SmartAPI | LIVE (captured during session) | SmartAPI | 5-min cadence; 4–6 snapshots may be missed on expiry day |
| Intraday OHLCV (1m–1h) | Angel One SmartAPI / Yahoo | LIVE during session, EXPIRED after | SmartAPI / Yahoo | **NOT PERSISTED. 30s Redis TTL. Lost after session.** |
| India VIX | Yahoo Finance | CACHED | yahoo-finance2 | `^INDIAVIX` |
| OI data | Angel One SmartAPI | LIVE (if creds active) | SmartAPI | Falls back to NSE chain scraper |
| AI signal confidence/scores | Heuristic computation | COMPUTED | Internal | ML service path not verified active |
| ML regime scores | Unknown — likely null | FALLBACK | None (ML service state unknown) | Falls back to heuristic 100% |
| Paper trade fills | Internal simulation | SIMULATED | N/A | No real broker fills |
| P&L figures in signal ledger | USD-denominated | ⚠️ INCONSISTENCY | N/A | **Signal ledger shows USD P&L but paper trading operates on INR ₹1L budget** |

**REAL-LIVE-DATA STATUS:** `PARTIAL`
- Live for: Option chain snapshots (Angel One, during session hours)
- Cached for: Daily OHLCV, index levels, VIX
- Not live: Intraday candles (lost after session), ML predictions (likely fallback)

---

## PART 3 — HARD BLOCKER ASSESSMENT

| Blocker | Present | Severity | Defect ID |
|---------|---------|----------|-----------|
| Critical data leakage | ❌ NOT FOUND | N/A | — |
| Broken signal → paper chain | ⚠️ PARTIAL | HIGH | DUP-001, AUDIT-001 |
| Unknown signal source | ❌ All sources traceable | N/A | — |
| Unverified live data | ⚠️ ML path unverified | MEDIUM | — |
| Paper capture failure | ⚠️ Duplicate inflation | HIGH | DUP-001 |
| Non-atomic trade guard | ✅ Redis lock present | — | — |
| Uncontrolled portfolio risk | ⚠️ Risk engine unwired | HIGH | RISK-001 |
| Uncalibrated probability | ⚠️ Shrinkage prior only | MEDIUM | — |
| Negative net expectancy | ⚠️ 2026-09-01 net negative | HIGH | See Truth Report |
| Severe cost fragility | ❌ Cost model implemented | — | — |
| Broken worker scheduling | ❌ All 14 jobs registered | — | — |
| Material data coverage gap | ⚠️ Intraday not persisted | HIGH | RCA-001 |
| Candle data empty in pipeline | ❌ CONFIRMED BLOCKER | CRITICAL | OPP-001 |

---

## PART 4 — SYSTEM PROMOTION STATE

```
CURRENT STATE: PAPER_READY (structure) / PAPER_VALIDATING (data accumulating)

NOT YET: PAPER_VALIDATED — requires 20+ diverse paper sessions with positive net expectancy
NOT YET: SHADOW_READY   — requires PAPER_VALIDATED + risk engine wired + candle pipeline wired
NOT YET: LIVE_CANDIDATE — requires explicit human approval + all blockers resolved

LIVE RECOMMENDATION: NO
```

---

## PART 5 — DEFECT REGISTRY

| ID | Severity | Title | Location | Fix |
|----|----------|-------|----------|-----|
| OPP-001 | CRITICAL | Opportunity pipeline receives empty candle arrays | `auto-trader.ts`, `opportunity-engine/route.ts` | Fetch real candles from provider before pipeline |
| DUP-001 | CRITICAL | Cross-timeframe duplicate signals inflate statistics | `india-scalper`, signal ledger | Add cross-timeframe deduplication at signal emission |
| RISK-001 | HIGH | `PortfolioRiskEngine` not wired in live trading path | `auto-trader.ts` | Query live session data for real portfolio state |
| RCA-001 | HIGH | `CandleBar` DB persistence not wired (known defect) | `worker/src/index.ts` | Register `CandleBuilderService` in worker bootstrap |
| AUDIT-001 | HIGH | Signal lifecycle events not persisted to DB | Signal Intelligence Engine | Wire `createLifecycleEvent` to DB writes |
| CAL-001 | MEDIUM | `isNseMarketOpenIST` does not check NSE holidays | `src/lib/india/market-hours.ts` | Use `NSETradingCalendar.isMarketOpen()` in workers |
| USD-001 | MEDIUM | Signal ledger P&L denominated in USD not INR | `today-signal-ledger-2026-09-01.json` | Confirm and fix P&L denomination in paper trade records |

---

## PART 6 — WHAT IS GENUINELY WORKING

1. **Worker scheduler:** All 14 jobs register, start, and run correctly with market-hours guards
2. **Daily Picks engine:** Fully wired — freezes top-3-per-bucket each day, live-tracks P&L, writes to `IndiaDailyPick` table
3. **EOD square-off:** Exactly-once execution via Redis distributed lock; all open India trades closed at 15:30 IST
4. **F&O scanners:** 6 scanner types run every 5 minutes during market hours
5. **Option chain capture:** Persisting `OptionChainSnapshot` rows every 5 minutes — building historical OC data over time
6. **Signal quality dashboard:** 20-phase evaluation renders from real `PaperTrade` + `SignalHistory` DB data
7. **Paper funnel visualization:** `PaperSignalFunnelCard` shows Signal→Risk→Execution→Outcome with bottleneck detection
8. **NSE Trading Calendar:** Fully implemented 2024–2026 with holidays, Muhurat sessions, expiry detection
9. **Transaction cost model:** 7-component NSE F&O costs implemented in `ExpectedValueEngine`
10. **Auto-trader opportunity pipeline:** v2 integration present — candidates route through 12-stage pipeline before trade open

---

*Generated by AlphaForge Production Day System Audit — 2026-09-02*
