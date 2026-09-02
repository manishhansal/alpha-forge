# AlphaForge — Next Session Paper Readiness Report

**Current Date:** 2026-09-02 (Wednesday, 22:55 IST — post-session)
**Next Session:** 2026-09-03 (Thursday)
**Session Type:** REGULAR + BANKNIFTY WEEKLY EXPIRY
**Market Hours:** 09:15–15:30 IST
**Expiry Context:** BANKNIFTY weekly expiry on Thursday. Enhanced gamma/IV environment expected, especially in the last 2 hours. All BANKNIFTY options signals carry expiry-day decay risk.

---

## READINESS DASHBOARD

| Component | Status | Severity | Notes |
|-----------|--------|----------|-------|
| DATA PROVIDER | ⚠️ WARN | MEDIUM | Angel One active; intraday bars not persisted (RCA-001) |
| UNIVERSE | ✅ PASS | — | 177 instruments loaded; 97.7% daily coverage |
| FEATURE ENGINE | ⚠️ WARN | MEDIUM | Candle-dependent features run on empty arrays (OPP-001) |
| SIGNAL ENGINE | ⚠️ WARN | MEDIUM | DUP-001 will inflate stats until fixed; signal generation functional |
| RISK ENGINE | ❌ FAIL | HIGH | PortfolioRiskEngine not wired (RISK-001) |
| PAPER ENGINE | ⚠️ WARN | MEDIUM | Auto-trader functional; lifecycle not persisted (AUDIT-001) |
| WORKER | ✅ PASS | — | All 14 jobs registered and starting correctly |
| REDIS | ✅ PASS | — | Redis ping OK at worker bootstrap; heartbeat emitting |
| DATABASE | ✅ PASS | — | Prisma ping OK; all tables migrated |
| ML SERVICE | ⚠️ WARN | MEDIUM | Not verified running; graceful fallback to heuristic |
| EXECUTION SIMULATOR | ✅ PASS | — | 7-component cost model active in paper trader |
| MONITORING | ⚠️ WARN | LOW | Worker heartbeat to Redis; no Sentry DSN configured |

---

## DETAILED STATUS BY COMPONENT

### DATA PROVIDER — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| Angel One SmartAPI credentials | ✅ PRESENT | All SMARTAPI_* keys in .env.local |
| Yahoo Finance fallback | ✅ ACTIVE | Always available |
| NSE direct scraper | ✅ ACTIVE | Cookie-warmed; fallback to Yahoo if fails |
| Option chain capture job | ✅ SCHEDULED | `india-oc-capture` at 5-min cadence |
| Intraday candle persistence | ❌ NOT WIRED | RCA-001: Only 30s Redis TTL; no DB writes |
| Provider health monitoring | ✅ ACTIVE | Circuit breaker with 0–100 health score |
| Daily OHLCV cache | ✅ ACTIVE | 4h Redis TTL; refreshes during market hours |

**Action required for next session:** None blocking. Angel One will serve live data from 09:15 IST. RCA-001 remains outstanding but does not prevent trading.

---

### UNIVERSE — ✅ PASS

| Check | Status | Notes |
|-------|--------|-------|
| F&O universe loaded | ✅ PASS | 177 instruments (4 indices + 173 stocks) |
| Daily OHLCV coverage | ✅ PASS | 97.7% (173/177) |
| Sector mapping | ✅ PASS | All sectors mapped in sectors.ts |
| BANKNIFTY weekly expiry flag | ✅ PASS | NSECalendar correctly identifies 2026-09-03 as BANKNIFTY expiry |
| Missing ticker aliases | ⚠️ WARN | TMPV, HYUNDAI, M&M, BAJAJ-AUTO have mapping workarounds |

---

### FEATURE ENGINE — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| Daily candle features (ATR, SMA, RSI) | ⚠️ PARTIAL | Computed from Yahoo 1d cache — available |
| Intraday candle features | ❌ HOLLOW | Empty arrays fed to pipeline (OPP-001) |
| Volume ratio (RVOL) | ❌ HOLLOW | Requires intraday volume history |
| VWAP | ❌ HOLLOW | Requires intraday candles |
| Multi-timeframe alignment | ❌ HOLLOW | No H1/M15/M5 candles available |
| ML features (Python) | ❌ UNAVAILABLE | ML service not verified active |
| Option chain features (PCR, IV, OI) | ✅ PARTIAL | Available from live option chain snapshots |

---

### SIGNAL ENGINE — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| India AI Signals builder | ✅ ACTIVE | 14-factor confluence, heuristic mode |
| Daily Picks engine | ✅ ACTIVE | Freeze-on-first-tick-per-day pattern |
| F&O scanners (6 types) | ✅ ACTIVE | 5-min cadence during market hours |
| Strategy registry | ✅ ACTIVE | 18 strategies registered |
| Cross-timeframe duplicate guard | ❌ NOT WIRED | DUP-001: Same signal fires on 1m/5m/15m |
| Signal freshness gate | ✅ PARTIAL | `dataAgeMs: 60_000` assumed age |
| BANKNIFTY expiry gamma cooldown | ✅ ACTIVE | Expiry-day gamma cooldown implemented in paper-trader-core.ts |

**Important for tomorrow (BANKNIFTY expiry):** The `india-scalper` includes an expiry-day gamma cooldown that reduces position sizing for ATM/near-ATM BANKNIFTY options in the last 2 hours. This is a correct risk control — do not disable it.

---

### RISK ENGINE — ❌ FAIL

| Check | Status | Notes |
|-------|--------|-------|
| PortfolioRiskEngine implementation | ✅ EXISTS | src/lib/risk/portfolio-risk.ts |
| Live portfolio state query | ❌ NOT WIRED | Hardcoded 0% drawdown, derived exposure only |
| VaR computation | ❌ NOT ACTIVE | Risk engine not called |
| CVaR computation | ❌ NOT ACTIVE | Risk engine not called |
| Correlation limit enforcement | ❌ NOT ACTIVE | Symbol-level dedup only |
| Sector concentration limit | ❌ NOT ACTIVE | No sector-level exposure tracking |
| Kill switch | ⚠️ PARTIAL | Implemented with hardcoded thresholds |
| Per-trade stop gate (2.5%) | ✅ ACTIVE | Enforced in auto-trader |
| Daily budget cap (₹1L) | ✅ ACTIVE | Hard limit enforced |

**RISK ENGINE VERDICT:** The budget cap and per-trade stop gate provide basic protection. The advanced risk controls (VaR, CVaR, correlation) are not active. This is HIGH priority for the next sprint.

---

### PAPER ENGINE — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| Auto-trader job | ✅ SCHEDULED | 60s cadence, runOnStart=true |
| Composite scoring | ✅ ACTIVE | 0.35×confidence + 0.25×winProb + 0.25×grade + 0.15×RR |
| Opportunity pipeline (v2) | ✅ WIRED | All candidates route through 12-stage pipeline |
| Budget management | ✅ ACTIVE | ₹1L daily budget, max 5 positions |
| EOD square-off | ✅ SCHEDULED | Redis lock, exactly-once, fires after 15:30 IST |
| Signal lifecycle persistence | ❌ NOT WIRED | AUDIT-001: No DB writes for lifecycle events |
| PaperTrade creation | ✅ ACTIVE | DB writes with retry logic |
| IndiaDaySession tracking | ✅ ACTIVE | Deployed capital, P&L, trade count |
| Last-entry cutoff (14:45) | ✅ ACTIVE | No new trades after 14:45 IST |
| P&L currency (INR) | ⚠️ VERIFY | USD-001: Confirm PaperTrade.pnlUsd vs pnlPct |

---

### WORKER — ✅ PASS

| Check | Status | Notes |
|-------|--------|-------|
| All 14 jobs registered | ✅ PASS | Confirmed in worker/src/index.ts |
| Redis ping at startup | ✅ PASS | `redis.ping()` at bootstrap |
| Postgres ping at startup | ✅ PASS | `$queryRaw SELECT 1` at bootstrap |
| Heartbeat emission | ✅ PASS | Every 60s to `worker:heartbeat` key (TTL 300s) |
| SIGTERM graceful shutdown | ✅ PASS | All jobs stopped, connections closed, Sentry flushed |
| Non-overlapping ticks | ✅ PASS | setTimeout (not setInterval) prevents overlap |
| Holiday guard | ⚠️ WARN | CAL-001: `isNseMarketOpenIST` doesn't check NSE holidays |
| Sentry error reporting | ⚠️ WARN | SENTRY_DSN not confirmed configured |

---

### REDIS — ✅ PASS

| Check | Status | Notes |
|-------|--------|-------|
| Redis connection | ✅ CONFIGURED | REDIS_URL in .env.local |
| Redis ping | ✅ PASS | Worker bootstrap verifies |
| Trade guard (dedup) | ✅ ACTIVE | Per-symbol Redis lock prevents duplicate trades |
| EOD distributed lock | ✅ ACTIVE | `acquireEodLock` for exactly-once square-off |
| Worker checkpoint | ✅ ACTIVE | Crash-recovery checkpoint in scalper |
| Heartbeat key | ✅ ACTIVE | `worker:heartbeat` TTL 300s |
| LRU eviction policy | ✅ CONFIGURED | Redis: 256MB max, LRU eviction (docker-compose) |

---

### DATABASE — ✅ PASS

| Check | Status | Notes |
|-------|--------|-------|
| PostgreSQL connection | ✅ CONFIGURED | DATABASE_URL in .env.local |
| Prisma ping | ✅ PASS | Worker bootstrap verifies |
| All tables migrated | ✅ PASS | Schema includes all 18 models |
| Unique constraints active | ✅ PASS | CandleBar, IndiaDailyPick, FnoTrendScan dedup |
| DB retry resilience | ✅ ACTIVE | `withDbRetry` in chaos module |
| Dead Letter Queue | ✅ ACTIVE | `paperTradeDLQ` for failed writes |

---

### ML SERVICE — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| ML_SERVICE_URL configured | ✅ CONFIGURED | In .env.local |
| ML service Docker container | ❓ UNKNOWN | Requires `docker-compose up ml-service` |
| Market regime model (trained) | ❌ NOT TRAINED | market_regime.json is config stub |
| Stock ranker (CatBoost artifact) | ⚠️ PARTIAL | strategy_selector.cbm exists |
| Graceful fallback to heuristic | ✅ ACTIVE | 60s TTL cache, null → heuristic |
| ML contribution to signal scoring | ❌ 0% | Fallback active |

---

### EXECUTION SIMULATOR — ✅ PASS

| Check | Status | Notes |
|-------|--------|-------|
| NSE 0.05 tick rounding | ✅ ACTIVE | paper-trader-core.ts |
| STT (0.0125% on options buy) | ✅ ACTIVE | ExpectedValueEngine cost model |
| Exchange charges | ✅ ACTIVE | NSE options: 0.053% |
| GST (18%) | ✅ ACTIVE | On brokerage + exchange |
| SEBI turnover fee | ✅ ACTIVE | 0.0001% |
| Stamp duty | ✅ ACTIVE | 0.003% buy side |
| Half-spread | ✅ ACTIVE | 3bps options, 2bps futures |
| ATR-based SL/TP | ✅ ACTIVE | paper-trader-core.ts |

---

### MONITORING — ⚠️ WARN

| Check | Status | Notes |
|-------|--------|-------|
| Worker heartbeat | ✅ ACTIVE | Redis key with 300s TTL |
| `/api/health/ready` | ✅ ACTIVE | Checks worker heartbeat staleness |
| Sentry error capture | ⚠️ WARN | SENTRY_DSN not confirmed configured |
| WhatsApp alerts (trade events) | ✅ ACTIVE (if configured) | WHATSAPP_EVOLUTION_API_URL required |
| Signal quality dashboard | ✅ ACTIVE | 20-phase evaluation at `/in/signal-quality` |
| Auto-trading dashboard | ✅ ACTIVE | Equity curve, stats at `/in/paper-trading` |

---

## EXPIRY DAY PROTOCOL (2026-09-03 — BANKNIFTY Weekly)

**Special considerations for BANKNIFTY weekly expiry:**

1. **Higher IV and gamma:** BANKNIFTY options near ATM will have elevated IV in the morning session. Option premiums can spike 2-5× during intraday moves.
2. **Gamma cooldown active:** The paper-trader-core.ts implements expiry-day gamma cooldown — near-ATM BANKNIFTY options get reduced position sizing. This is CORRECT behavior. Do not disable.
3. **OC snapshots:** The `india-oc-capture` job will capture more volatile option chain states. PCR and max pain values may shift significantly intraday.
4. **Signal timing:** Opening breakout signals on BANKNIFTY expiry days should be treated with extra caution — the 09:15–09:30 window often sees exaggerated moves that quickly reverse.
5. **Data quality:** NSE direct endpoint may be slower on expiry days (higher traffic). Angel One SmartAPI is the preferred data source.

---

## SESSION READINESS SUMMARY

```
OVERALL READINESS: ⚠️ WARN — Paper session can proceed with caveats

READY FOR PAPER TRADING: YES (with limitations)
READY FOR LIVE TRADING:  NO ❌

KNOWN LIMITATIONS FOR TOMORROW'S SESSION:
  - Signal statistics will be inflated 3× by DUP-001 (cross-timeframe duplicates)
  - Quality scores partially hollow due to empty intraday candle arrays (OPP-001)
  - Lifecycle events not persisted — missed signal analysis unavailable (AUDIT-001)
  - Risk engine not wired — correlation and sector concentration unenforced (RISK-001)
  - ML service contribution: 0% (heuristic only)

MITIGATIONS ACTIVE:
  - 5-position cap limits maximum risk exposure
  - 2.5% per-trade stop gate limits individual trade loss
  - EOD square-off ensures no overnight risk
  - Angel One live data ensures execution quality
  - Expiry-day gamma cooldown active for BANKNIFTY options
  - Duplicate symbol guard prevents same instrument entering twice
```

---

## RECOMMENDED ACTIONS BEFORE NEXT SESSION

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| CRITICAL | Deploy DUP-001 fix (cross-timeframe dedup) | 30 min | Fixes statistical inflation |
| CRITICAL | Deploy AUDIT-001 fix (lifecycle persistence) | 2 hr | Enables capture rate measurement |
| HIGH | Deploy OPP-001 fix (wire candles to pipeline) | 4 hr | Improves quality scoring accuracy |
| HIGH | Deploy RISK-001 fix (wire PortfolioRiskEngine) | 2 hr | Enables real risk control |
| MEDIUM | Start ML service (`docker-compose up ml-service`) | 5 min | Activates ML scoring path |
| MEDIUM | Configure SENTRY_DSN | 10 min | Enables error alerting |
| LOW | Deploy CAL-001 fix (holiday-aware market guard) | 1 hr | Prevents off-holiday job execution |

---

*AlphaForge Next Session Paper Readiness Report — 2026-09-02*
*Next session: 2026-09-03 (BANKNIFTY expiry Thursday)*
