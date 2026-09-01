# TODAY'S ROOT CAUSE ANALYSIS — 2026-09-01

**Generated:** 2026-09-01 22:10 IST

---

## FAILURE / FINDING REGISTRY

---

### RCA-001 · CandleBar Table Empty

| Field | Value |
|---|---|
| Classification | DATABASE_FAILURE |
| Severity | MEDIUM |
| Description | The `CandleBar` table is defined in `prisma/schema.prisma` with a TimescaleDB-compatible schema but contains 0 rows. No worker job writes to it. The entire intraday candle pipeline uses Redis TTL cache only. |
| Root Cause | The `CandleBar` table was designed as a persistent store for intraday OHLCV candles but was never wired to any writer path. The `getHistoricalCandlesByRange()` function reads from Angel One API (with Redis cache) and never writes results to the DB. |
| Impact | Post-session intraday replay impossible. Cannot independently validate 1m/5m/15m signal triggers after candle cache TTLs expire (30s–4h). Certification of intraday signal accuracy is reduced to CANNOT_INDEPENDENTLY_VALIDATE. |
| Affected Signals | All OPENING_BREAKOUT, MOMENTUM (intraday), LIQUIDITY_EDGE, MAX_PAIN_GRAVITY, IV_SPIKE, PCR_EXTREME, OI_BUILDUP signals (321 paper trades) |
| Fix | Wire the candle fetch path to write confirmed candles to `CandleBar` after each successful fetch: `prisma.candleBar.upsert({ where: { instrumentId_exchange_intervalStr_time }, create/update: { ... } })` |
| Regression Test | After fix: verify CandleBar row count > 0 after first India scalper tick; verify upsert idempotency (run twice, count unchanged) |

---

### RCA-002 · Option Chain Capture Gap (12:51–15:30 IST)

| Field | Value |
|---|---|
| Classification | DATA_FAILURE |
| Severity | LOW |
| Description | The `india-oc-capture` job captured 28-30 option chain snapshots per index from 09:23 IST to 12:51 IST, then stopped. The last 2h38m of the session (12:51–15:30 IST) has no OptionChainSnapshot records. |
| Root Cause | Unknown from available evidence. Possible causes: (a) `india-oc-capture` job tick timing drift causing the job's next tick to fall outside market hours by accumulated delay; (b) provider rate limit / NSE throttling causing repeated failures that the job silently swallowed; (c) worker process encountered a non-fatal error in the job loop after ~12:51 IST. Worker heartbeat continued (last heartbeat at 22:01 IST confirms worker was alive), so a full process crash is ruled out. |
| Impact | PCR, ATM IV, max pain and OI data missing from DB for the 12:51–15:30 IST window. Live Redis served real-time data during this window (15s TTL), so trading decisions were not affected. Historical analysis and backtesting of afternoon session PCR/OI signals is impaired. |
| Affected Signals | LIQUIDITY_EDGE, MAX_PAIN_GRAVITY, PCR_EXTREME, IV_SPIKE signals opened during the 12:51–15:30 window would have used last-known cached option chain data (Redis 15s TTL) — acceptable for live decisions but not recorded in DB. |
| Fix | Add error logging to `india-oc-capture` tick with explicit capture of failure reason. Add a DB health check: alert if snapshot count for the current session day is below `floor((elapsed_session_minutes/5)) × 0.9`. |
| Regression Test | Verify `OptionChainSnapshot` record count ≥ 74 rows per session (4 indices × 37 intervals × ~90% capture rate) |

---

### RCA-003 · PortfolioRiskEngine Not Wired to India Scalper

| Field | Value |
|---|---|
| Classification | RISK_FAILURE |
| Severity | MEDIUM |
| Description | The `PortfolioRiskEngine` with 8 evaluation stages (kill switch, VaR, drawdown, exposure, correlation, risk budget, sizing) is not called in the India scalper paper trading path. |
| Root Cause | The India scalper was implemented with simpler deduplication gates (`duplicate-signal`, `already-open`, `expiry-cooldown`). The full risk engine was developed independently for the backtesting/Strategy Lab paths. Integration was not completed for the live scalper path. |
| Impact | No portfolio-level risk controls on India scalper trades: no kill switch on large losses, no VaR limit, no sector concentration limit, no correlation-based position blocking. Today's -₹32,624 realized loss on scalper trades could theoretically grow unchecked. |
| Affected Signals | All 321 scalper paper trades |
| Fix | Wire `PortfolioRiskEngine.evaluate()` into `openIndiaPaperTrade()` before `prisma.paperTrade.create()`. Create a singleton engine instance in the worker with configured India-specific limits. |
| Regression Test | Test that HARD_KILL blocks new trade creation; test that DRAWDOWN_HALT fires at 4% daily loss; test that SECTOR_CONCENTRATION blocks when sector exceeds limit. |

---

### RCA-004 · Dual Expiry Format in OptionChainSnapshot

| Field | Value |
|---|---|
| Classification | DATA_FAILURE |
| Severity | LOW |
| Description | BANKNIFTY, FINNIFTY, and MIDCPNIFTY have both `29-Sep-2026` (29 rows) and `2026-09-29` (1 row) format expiry strings in the `OptionChainSnapshot` table. |
| Root Cause | Two different code paths normalize the expiry date string differently. The NSE library returns `DD-Mon-YYYY` format while an updated provider path uses ISO `YYYY-MM-DD`. |
| Impact | Queries filtering by expiry may return incomplete results if they don't normalize the format. Aggregations across the day could double-count or miss rows. The 1 ISO-format row is from the 07:21 UTC snapshot — a different provider or path. |
| Affected Signals | None directly; affects only historical analysis accuracy |
| Fix | Normalize all expiry strings to `DD-Mon-YYYY` at write time (matching `normaliseExpiry()` from `src/lib/market-data/normalizer.ts`); add a DB constraint or migration to enforce one format. |
| Regression Test | Verify all OptionChainSnapshot rows for the same underlying+tradeDate have identical expiry format. |

---

### RCA-005 · INDICES_SCALP Daily Picks — Extremely Tight Stop on Expiry Day

| Field | Value |
|---|---|
| Classification | STRATEGY_LOGIC_FAILURE |
| Severity | MEDIUM |
| Description | INDICES_SCALP daily picks for NIFTY and FINNIFTY on their weekly expiry day (Sep 1, 2026) have extremely tight stops: NIFTY entry=27.10 SL=0.05, FINNIFTY entry=316.00 SL=195.95. Both immediately hit STOP_HIT. |
| Root Cause | The INDICES_SCALP bucket deals in option premiums (not index levels). On weekly expiry day, ATM options have very low time value and are highly sensitive to intraday moves. The stop at ₹0.05 for NIFTY (entry ₹27.10) is a 99.8% stop loss — it means the option can only lose 0.18% before stopping out. This is actually extremely tight delta hedging but appears structurally wrong for the trade setup. |
| Impact | Both INDICES_SCALP picks immediately stopped out. The confidence (0.28) and winProbability (0.34) were correctly low, but the system still opened the trade and immediately closed it. |
| Fix | Add expiry-day filter for INDICES_SCALP picks: widen stop to at least 20% of option premium, or skip indices on their own weekly expiry day. |
| Regression Test | Test that `IndiaDailyPick` builder applies wider stops on expiry-day option picks; test that stop distance > 15% of option premium. |

---

### RCA-006 · Signal Snapshotter Missing SMA-50 / SMA-200 Inputs

| Field | Value |
|---|---|
| Classification | FEATURE_FAILURE |
| Severity | LOW |
| Description | The signal snapshotter computes scores with `sma50: null, sma200: null, targetMean: null` for all stocks because `yahoo.getQuotes()` only returns price and changePct, not moving averages. This means factors 1 and 2 (SMA-50 proximity: 15pts; SMA-200 proximity: 15pts) always contribute 0 pts to the score. |
| Root Cause | The snapshotter was designed to use bulk Yahoo `getQuotes()` for speed (batch of 50 symbols). Full SMA computation requires 200-candle historical series per symbol — expensive for 172 stocks every 60 seconds. The `snapshotChunk()` function explicitly sets `sma50: null, sma200: null`. |
| Impact | Score range effectively reduced from ±100 to ±70 (30 pts from SMA factors unavailable). Signal labels (BUY/SELL/HOLD) are computed from a partial score, potentially missing stocks that are above/below key moving averages. |
| Fix | Option A: Pre-compute SMA-50/200 from the cached 1y daily series on each snapshot tick (async, using already-cached data). Option B: Add a separate daily SMA cache (`sma:{SYMBOL}`) updated once per day after market close. Option C: Accept current behavior as designed (fast bulk scoring, not full technical score). |
| Regression Test | Test that `computeScore()` with non-null SMA inputs produces higher magnitude scores than null inputs for the same stock. |

---

### RCA-007 · Scalper Risk Rejections Not Persisted

| Field | Value |
|---|---|
| Classification | DATABASE_FAILURE |
| Severity | LOW |
| Description | The India scalper's rejection reasons (`duplicate-signal`, `already-open`, `expiry-cooldown`) are logged to worker stdout only, not persisted to the database. Post-session audit cannot determine how many signals were rejected or for what reason. |
| Root Cause | The worker uses structured logging (`createLogger`) for operational output but has no DB table for recording signal rejection events. |
| Impact | Incomplete audit trail. Cannot independently verify that duplicate prevention was working correctly without re-running the session. |
| Fix | Add a lightweight `IndiaSignalEvent` table or Redis sorted-set to record signal generation attempts with outcome (opened/rejected/reason). |
| Regression Test | Test that after calling `openIndiaPaperTrade()` with a duplicate signal, a rejection event is persisted. |

---

## FINDINGS SUMMARY TABLE

| RCA-ID | Category | Severity | Fix Required | Test Required |
|---|---|---|---|---|
| RCA-001 | DATABASE_FAILURE | MEDIUM | Wire CandleBar writer | Unit + integration |
| RCA-002 | DATA_FAILURE | LOW | Add OC capture error logging + health check | Integration |
| RCA-003 | RISK_FAILURE | MEDIUM | Wire PortfolioRiskEngine to scalper | Unit + integration |
| RCA-004 | DATA_FAILURE | LOW | Normalize expiry format | Unit |
| RCA-005 | STRATEGY_LOGIC_FAILURE | MEDIUM | Widen expiry-day option stops | Unit |
| RCA-006 | FEATURE_FAILURE | LOW | Add SMA computation to snapshotter | Unit |
| RCA-007 | DATABASE_FAILURE | LOW | Persist signal rejection events | Unit |

**Total findings: 7**  
**Critical/blocking: 0**  
**Medium: 3**  
**Low: 4**
