# AlphaForge — India Paper Trading Reconciliation
**Date:** 2026-09-03  
**Status:** NOT_TESTED — requires live session data

---

## Reconciliation Framework

Every accepted signal eligible for paper trading must be traceable through:

```
Signal generated
      ↓
Signal scored (Opportunity Engine: score ≥ 0.52)
      ↓
Signal approved (12-stage pipeline)
      ↓
Paper trade created (PaperTrade table)
      ↓
Paper trade tracked (SL/TP/EOD)
      ↓
Outcome recorded (pnlPct, closeReason, closedAt)
```

Any discrepancy between steps is an anomaly requiring explanation.

---

## Paper Trade Data Provenance (V2.1)

Every PaperTrade row now carries full data provenance:

| Field | Purpose |
|-------|---------|
| `dataObservationId` | Links to LineageStore observation ID |
| `quoteAgeAtEntryMs` | Quote age at signal generation |
| `dataConfidenceAtEntry` | DataQualityGate score (0–95) |
| `dataQualityAtEntry` | VALID/DEGRADED/INVALID/UNKNOWN |
| `dataProviderAtEntry` | Which provider supplied entry data |
| `signalId` | Source signal that triggered this trade |
| `featureVersion` | ML feature vector version |
| `dataIsFallback` | Whether fallback data was used |
| `observationEventTime` | Exchange event time of entry quote |

This enables forensic reconstruction: "What exactly did the system know when it opened this trade?"

---

## Reconciliation Checks

| Check | Query | Expected |
|-------|-------|---------|
| Every approved signal → paper trade exists | `PaperTrade WHERE source LIKE 'in:%'` | 1:1 or explained exception |
| Every open trade → has valid entry | `PaperTrade WHERE status='OPEN' AND entry > 0` | 100% |
| Every closed trade → has exit price | `PaperTrade WHERE status != 'OPEN' AND exitPrice IS NOT NULL` | 100% |
| Every STOP_HIT → exitPrice ≈ stopLoss | `\|exitPrice - stopLoss\| < 0.5%` | ≥ 95% |
| Every TARGET_HIT → exitPrice ≈ target | `\|exitPrice - target\| < 1%` | ≥ 95% |
| EOD exits at 15:30 IST | `closedAt BETWEEN 15:25–15:35 IST WHERE closeReason='EOD'` | 100% |
| No duplicate open trades per strategy+symbol | `COUNT(*) > 1 WHERE status='OPEN' GROUP BY source, symbol` | 0 rows |
| Currency matches market | `currency = 'INR' WHERE source LIKE 'in:%'` | 100% |

---

## DUP-001 Reconciliation

**Before fix:** Same signal generated paper trades at 1m, 5m, and 15m = 3× inflation  
**After fix:** `existingOpenAnyTf` guard — only first timeframe opens a trade

**Validation query:**
```sql
SELECT source, symbol, COUNT(*) as count
FROM "PaperTrade" 
WHERE source LIKE 'in:%' 
  AND status = 'OPEN'
  AND "openedAt" > NOW() - INTERVAL '30 minutes'
GROUP BY 
  SPLIT_PART(source, ':', 2),  -- strategyId
  symbol
HAVING COUNT(*) > 1;
-- Expected: 0 rows
```

---

## Today's Reconciliation — NOT_TESTED

| Metric | Expected | Actual |
|--------|---------|--------|
| Signals approved by Opportunity Engine | 3–8 | NOT_TESTED |
| Paper trades opened | = approved | NOT_TESTED |
| Paper trades with provenance fields | 100% | NOT_TESTED |
| DUP-001 violations (any open duplicate) | 0 | NOT_TESTED |
| EOD square-offs at 15:30 | All open positions | NOT_TESTED |
| IndiaDaySession.finalised | true | NOT_TESTED |
| P&L reconciled to IndiaDaySession | ± ₹1 rounding | NOT_TESTED |

---

## Paper Trading Fidelity

Fill model from `src/lib/signal-intelligence/paper-trading-fidelity.ts`:

```
fill_price = mid_price + (0.5 × spread) + market_impact + latency_drift

where:
  spread         = (ask - bid) from last known quote depth
  market_impact  = estimated from notional size / ADV
  latency_drift  = signal_timestamp - execution_timestamp (typically 50–200ms)
```

This is NOT candle-close execution — it simulates realistic fill at a slightly worse price than the mid.

---

*Report to be updated from production `IndiaDaySession` table after market hours.*
