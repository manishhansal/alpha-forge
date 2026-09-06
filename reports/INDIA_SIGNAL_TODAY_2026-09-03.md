# AlphaForge — Today's Signal Results
**Date:** 2026-09-03 (Thursday)  
**Session:** Full day (09:15–15:30 IST)  
**Status:** NOT_TESTED — broker credentials not configured

---

## Non-Fabrication Declaration

Per the project's non-negotiable principles:

> "If an external provider is unavailable: report unavailable, record exact reason, continue with other available providers, mark validation as NOT_TESTED where appropriate."
> "Never manufacture today's prices, candles, signals, P&L, provider agreement, latency, or win rate."

Today's (2026-09-03) signal results are **NOT_TESTED** because:

1. **Angel One SmartAPI** — `SMARTAPI_API_KEY` not configured in this environment
2. **Upstox API** — `UPSTOX_ANALYTICS_TOKEN` not configured in this environment
3. **Live market data** — Without broker credentials, live 1m candle replay is not possible
4. **Yahoo Finance** — Available but 15-min delayed; insufficient for 1-minute session replay

---

## What Would Have Been Measured

If broker credentials were available and this ran as a production validation:

### Signal Generation Phase (09:15–15:30 IST)

| Metric | Expected Range | Actual |
|--------|---------------|--------|
| AI Signal candidates | 20–40 | NOT_TESTED |
| AI Signals generated (action ≠ WAIT) | 5–15 | NOT_TESTED |
| Daily Picks generated | 10–15 (2–3 per bucket) | NOT_TESTED |
| F&O Scanner hits (all 6 types) | 30–80 | NOT_TESTED |
| FnO Trend bullish signals | 0–20 | NOT_TESTED |
| FnO Trend bearish signals | 0–20 | NOT_TESTED |
| Scalper signals (9 strategies × 3 TFs) | 50–200 | NOT_TESTED |
| After deduplication (clusters) | 15–40 | NOT_TESTED |
| Opportunity Engine approved | 3–8 | NOT_TESTED |
| Paper trades opened | 3–5 | NOT_TESTED |

### Session Replay Plan

The 1-minute replay would have followed:

```
09:15 → First candle
09:16 → Second candle
...
For each 1m bar:
  1. Ingest candle via data-service → broker API
  2. Validate OHLC (filterValidCandles)
  3. Update indicators (SMA/EMA/RSI/ATR/ADX)
  4. Update market regime (trending/ranging/volatile)
  5. Update derivatives state (PCR/IV/OI from option chain)
  6. Evaluate all signal families
  7. Apply DataQualityGate
  8. Cluster and deduplicate
  9. Route approved signals to Opportunity Engine
  10. Record all lifecycle events
15:30 → EOD square-off
```

### Anti-Look-Ahead Validation

For each signal generated at time T:
- ✓ Only data available by time T used for entry decision
- ✓ Future candles used only for outcome calculation (MFE/MAE)
- ✓ Market session at T checked (not end-of-day snapshot)

---

## Today's Market Context (Best Effort — NOT_TESTED)

| Index | Session Result | Source |
|-------|---------------|--------|
| NIFTY 50 | NOT_TESTED | Would use Angel One / Upstox |
| BANKNIFTY | NOT_TESTED | Would use Angel One / Upstox |
| FINNIFTY | NOT_TESTED | Would use Angel One / Upstox |
| INDIA VIX | NOT_TESTED | Would use Angel One / Upstox |

---

## Missed Opportunity Analysis Framework

False negatives that would have been analyzed (Phase 28):

| Category | Detection Method |
|----------|-----------------|
| Strong breakouts not captured | Compare signal universe vs actual price moves >2% |
| Trend continuations missed | Check all FnO stocks for consistent 1m candle direction |
| Large OI build-up ignored | OI change > 20% without corresponding signal |
| Abnormal volume without signal | Volume > 3× avg without scanner hit |
| Index breakout/reversal | NIFTY moves > 0.5% within 15m without AI Signal |

---

## Required Infrastructure for Live Validation

To run today's session replay:

```bash
# 1. Configure credentials
export SMARTAPI_API_KEY=xxx
export SMARTAPI_CLIENT_CODE=xxx
export SMARTAPI_PIN=xxxx
export SMARTAPI_TOTP_SECRET=xxx
export UPSTOX_ANALYTICS_TOKEN=xxx

# 2. Start services
docker compose up -d  # postgres + redis
uvicorn src.server:app --host 0.0.0.0 --port 8200 &  # data-service

# 3. Run the worker (this populates CandleBar, SignalHistory, PaperTrade)
npm run worker:dev

# 4. Review signal audit
GET /api/in/signal-center

# 5. Review paper trades
GET /api/in/paper-trade
```

---

## Conclusion

**Status: NOT_TESTED**

Today's signal results cannot be reported without broker credentials. This is an honest limitation of the validation environment.

The architecture to support this validation is fully implemented:
- ✓ 1m candle builder (`CandleBar` table)
- ✓ Signal history (`SignalHistory` table)
- ✓ Paper trades with provenance (`PaperTrade` + `dataObservationId`)
- ✓ Signal lifecycle events (`SignalLifecycleEvent`)
- ✓ Opportunity clustering (`OpportunityCluster`)
- ✓ Today's audit ledger (`reports/today-signal-ledger-2026-09-01.json` — previous session example)

The system will produce real results once broker credentials are configured in production.
