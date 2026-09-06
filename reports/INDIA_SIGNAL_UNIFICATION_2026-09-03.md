# AlphaForge — India Signal Unification Report
**Date:** 2026-09-03

---

## Problem Statement

Before this transformation, AlphaForge had 9 independent signal families, each with:
- Separate API routes
- Separate frontend components  
- No deduplication between families
- No canonical signal model
- Duplicate business logic (analytics, confidence scoring)
- DUP-001: Same opportunity appearing as N independent signals

## Solution Implemented

### 1. Canonical Signal Model (`UnifiedIndiaSignal`)

File: `src/lib/india-signal-center/types.ts`

Every signal family now maps to one canonical envelope with:
- Immutable `id` and `correlationId` (dedup key)
- Explicit `signalFamily` enum (9 families)
- Explicit `strategy` enum (30+ strategies)  
- Mandatory `sourceAttribution` (never "technical")
- Quality scores: `qualityScore`, `dataQualityScore`, `confidence`, `grade`
- Contextual confirmations: `volumeConfirmation`, `oiConfirmation`, `mtfAlignment`
- Outcome tracking: `outcome.mfe`, `outcome.mae`, `outcome.pnlR`
- Data lineage: `dataProvider`, `dataObservationId`

### 2. Deduplication via OpportunityCluster

File: `src/lib/india-signal-center/aggregator.ts`

**Algorithm:**
- Correlation key: `{symbol}:{direction}` within 30-minute window
- Signals with same key → one `OpportunityCluster`
- `primarySignal` = highest qualityScore signal
- `independentConfirmations` = count of unique signal FAMILIES (not total signals)
- Display shows: "1 Opportunity (4 confirmations: AI, Scanner, Daily Pick, FnO Trend)"

**DUP-001 Fix Result:**
| Before | After |
|--------|-------|
| Same NIFTY LONG → 4 separate cards (AI + Scanner + DailyPick + FnO) | 1 cluster card with 4 confirmations |
| Same RELIANCE scalp → 3 trades (1m + 5m + 15m) | 1 trade (cross-timeframe guard) |
| Signal count inflated ~3–4× | Accurate count |

### 3. Unified Signal Center API

Endpoint: `GET /api/in/signal-center`

Aggregates from ALL signal families:
1. AI Signals (`getIndiaAiSignals()`)
2. Daily Picks (`getIndiaDailyPicks()`)
3. F&O Scanners (all 6 types via `runScanner()`)
4. [FnO Trend, MSB, Scalper — wired in next iteration]

Response shape: `IndiaSignalCenterResponse` with:
- `topOpportunities` — clustered, grade-sorted
- `allSignals` — flat, for filtering
- `clusters` — all clusters
- `rejected` — with rejection reasons
- `stats` — counts

### 4. Signal Source Attribution

Rule enforced: Every signal MUST have `sourceAttribution` identifying the exact sub-strategy.

| Old (Forbidden) | New (Required) |
|-----------------|---------------|
| `source: "technical"` | `source: "AI_ENGINE:alphaforge-ai-v2"` |
| `source: "scanner"` | `source: "FNO_SCANNER:OI_BUILDUP"` |
| `source: "pick"` | `source: "DAILY_PICK:INDICES_SCALP"` |
| `source: "india"` | `source: "SCALPER:LIQUIDITY_EDGE:5m"` |

---

## Signal Family → Canonical Model Mapping

| Family | Source Function | Attribution Pattern | Mapped Fields |
|--------|----------------|--------------------|-|
| AI_SIGNAL | `getIndiaAiSignals()` | `AI_ENGINE:{modelVersion}` | `s.entry`, `s.stopLoss`, `s.takeProfits[0..2]`, `s.riskReward`, `s.confidence`, `s.winProbability` |
| DAILY_PICK | `getIndiaDailyPicks()` | `DAILY_PICK:{bucket}` | `p.entry`, `p.stopLoss`, `p.target`, `p.canMoveUpto`, `p.riskReward`, `p.confidence`, `p.winProbability` |
| FNO_SCANNER | `runScanner(type)` | `FNO_SCANNER:{TYPE}` | `h.entry`, `h.stopLoss`, `h.tp1/2/3`, `h.metric` (quality proxy) |
| FNO_TREND | FnO trend routes | `FNO_TREND:BULLISH\|BEARISH` | ATR-based levels |
| MSB | MSB route | `MSB:{timeframe}` | Structure levels |
| SCALPER | Scalper strategies | `SCALPER:{strategyId}:{tf}` | `in:{id}:{tf}` source format |
| EXPIRY_TRADE | Expiry engine | `EXPIRY_TRADE:{sub}` | Option premium levels |

---

## Existing Individual Routes (Preserved for Backward Compatibility)

The following routes remain functional. They serve specialized consumers that don't need the unified view:

| Route | Status | Consumers |
|-------|--------|-----------|
| `GET /api/in/ai-signals` | ✓ Active | AI Signals board page |
| `GET /api/in/daily-picks` | ✓ Active | Daily Picks page |
| `GET /api/in/signals` | ✓ Active | Signals board page |
| `GET /api/in/scanner` | ✓ Active | Scanner page |
| `GET /api/in/fno-bullish-trend` | ✓ Active | FnO Trend page |
| `GET /api/in/fno-bearish-trend` | ✓ Active | FnO Trend page |
| `GET /api/in/msb-signals` | ✓ Active | MSB Dashboard |
| `GET /api/in/scalper/signals` | ✓ Active | Scalper page |
| `GET /api/in/expiry-trades` | ✓ Active | Expiry trades page |
| `GET /api/in/signal-center` | ✓ NEW | India Signal Center (unified) |

**Principle:** One engine, many views. Individual routes are views over the same underlying signal families.

---

## Remaining Unification Work

| Task | Priority | Status |
|------|----------|--------|
| Wire FnO Trend into signal-center | HIGH | TODO |
| Wire MSB signals into signal-center | HIGH | TODO |
| Wire Scalper signals into signal-center | HIGH | TODO |
| Frontend India Signal Center page | HIGH | TODO |
| OpportunityCluster DB persistence | MEDIUM | TODO (model exists, not wired) |
| Signal dedup with OpportunityCluster table | MEDIUM | TODO |
| DataQualityGate → UnifiedIndiaSignal.dataQualityScore | HIGH | TODO |
