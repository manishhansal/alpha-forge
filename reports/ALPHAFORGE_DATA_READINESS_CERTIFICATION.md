# ALPHAFORGE — DATA READINESS CERTIFICATION

Final verdict (brief §88 vocabulary): **DATA_DEGRADED → improving.**

The highest-severity integrity defects (fabricated OI/volume zeros;
stale-as-live timestamps; weak candle validation; silent candle drops) are
**FIXED and verified**. Two architectural items remain **INFRA** (a durable
gap/incident/version data model, and wiring the quality envelope into every
read path) — these are designed below but not applied in this pass because they
touch the production schema / have broad blast radius and warrant review.

No ML, signal-threshold, A+/grade, or profitability code was changed. No data
was fabricated. No signal gate was weakened.

---

## 1. §75 certification checklist

Legend: ✅ present & sound · 🟡 partial · ⛔ missing/INFRA.

| Item | Status | Evidence / note |
|---|---|---|
| provider chain | ✅ | `types.ts` PROVIDER_PRIORITY; `registry.ts` bootstrap |
| failover | ✅ | `failover.ts` capability-aware, cooldown |
| retry | ✅ | 3 attempts + ladder (TS & Python) |
| rate limiting | 🟡 | TS token buckets + Python NSE/BSE limiter; NextApi/Upstox unthrottled in Python |
| circuit breakers | ✅ | per-provider + per-capability (`health.ts`), per-source (Python) |
| caching | 🟡 | TTL cache works; no `createdAt/expiresAt/provider/dataTimestamp` wrapper (S4) |
| persistence | ✅ | `CandleBar`/`OptionChainSnapshot` idempotent upsert |
| historical coverage | 🟡 | Bhavcopy + broker history; no coverage matrix / `INSUFFICIENT_HISTORY` type |
| real-time continuity | 🟡 | reconnect gap-fill exists; unrecovered gaps not persisted |
| gap recovery | 🟡 | recovery attempted; no `DataGap` ledger |
| timestamps | ✅ | IST↔UTC correct; stale-as-live FIXED |
| OHLC validation | ✅ | reject-on-invalid (TS + Python); Upstox path strengthened |
| options | 🟡 | validated on signal side (`fno-data-quality.ts`); data-service lacks crossed-market/stale-OI checks |
| OI | ✅ | missing-OI no longer fabricated as 0 (FIXED) |
| IV | ✅ | missing IV kept null (was already correct) |
| symbol master | 🟡 | present; Upstox master unsupported; hardcoded fallback list |
| market calendar | ✅ | `nse-trading-calendar.ts` |
| provenance | 🟡 | quotes/chains carry provider+fetchedAt; candles lack provider; lineage in-memory only |
| data quality | 🟡 | quality engine exists (`reconciliation.service.ts`) but not on default reads |
| data readiness | 🟡 | feature-readiness on signal side; not a data-layer contract |
| signal veto | ✅ | `evaluateSignalGate` blocks STALE/SUSPICIOUS for SIGNAL/ML/EXEC |
| observability | 🟡 | structured `mdLog` events incl. new PROVIDER_FAILED; no metrics counters yet |
| alerts | 🟡 | OC-capture staleness alert; broader alerting (§52) not built |
| security | ✅ | proxy/creds masked; no bearer-in-log path found; PII not applicable |

---

## 2. §76 production data gates — status

These are the machine-enforced gates a signal must pass. Where a gate is
enforced today vs. where it depends on INFRA:

| Gate | Enforced? |
|---|---|
| CRITICAL_DATA_AVAILABLE | 🟡 signal-side gates exist; not a unified data-layer gate |
| DATA_FRESH | ✅ staleness thresholds + gate (stale-as-live paths now honest) |
| DATA_COMPLETE | 🟡 needs coverage matrix |
| DATA_CONSISTENT | 🟡 snapshot-skew check not enforced (brief §37) |
| PROVIDER_HEALTHY | ✅ circuit breaker + health score |
| HISTORY_SUFFICIENT | 🟡 needs `INSUFFICIENT_HISTORY` result type |
| INSTRUMENT_VALID | ✅ instrument resolver |
| OPTIONS_VALID | ✅ `fno-data-quality.ts` (now fed honest nulls, not fabricated 0s) |
| OI_VALID | ✅ improved — missing-OI flagged, excluded from analytics |
| IV_VALID | ✅ null-preserving |

---

## 3. INFRA designs (not applied — awaiting review)

### 3.1 RCA-D07 — durable data-reliability models (additive, non-destructive)

Proposed Prisma models (safe, additive migration — **NEVER drop existing data**):

```prisma
model DataGap {
  id             String   @id @default(cuid())
  instrumentId   String
  exchange       String
  intervalStr    String
  gapStart       Int      // UTC epoch seconds (first missing candle open)
  gapEnd         Int      // UTC epoch seconds (last missing candle open)
  durationSec    Int
  provider       String?  // provider that was expected to supply it
  recoveryStatus String   // PENDING | RECOVERED | UNRESOLVED | MARKET_CLOSED
  detectedAt     DateTime @default(now())
  recoveredAt    DateTime?
  @@unique([instrumentId, exchange, intervalStr, gapStart])
  @@index([recoveryStatus])
}

model DataQualityIncident {
  id            String   @id @default(cuid())
  severity      String   // INFO | WARNING | ERROR | CRITICAL
  provider      String?
  instrumentId  String?
  intervalStr   String?
  failureType   String   // STALE | MISSING | DUPLICATE | INVALID_OHLC | PROVIDER_FAILED | ...
  detectionTime DateTime @default(now())
  recoveryTime  DateTime?
  status        String   // OPEN | RESOLVED
  rootCause     String?
  detail        Json?
  @@index([severity, status])
  @@index([detectionTime])
}

model ProviderObservation {   // RAW vs NORMALIZED separation (brief §56)
  id              String   @id @default(cuid())
  instrumentId    String
  dataType        String   // QUOTE | CANDLE | OPTION_CHAIN
  provider        String
  sourceTimestamp DateTime?
  receivedAt      DateTime @default(now())
  rawPayload      Json     // exactly what the provider returned
  @@index([instrumentId, dataType, receivedAt])
}
```

Also recommended (additive): a `provider String?` column on `CandleBar` so
provider distribution / lineage is queryable (coverage report §5).

### 3.2 RCA-D06 — wire the quality envelope into read paths

Add non-breaking sibling APIs that return a `DataAvailability` envelope, leaving
the existing bare-array/object functions intact:

```ts
type DataAvailability<T> = {
  data: T;
  status: "AVAILABLE" | "PARTIAL" | "STALE" | "UNAVAILABLE"
        | "INVALID" | "PROVIDER_FAILED" | "RATE_LIMITED"
        | "AUTH_FAILED" | "INSUFFICIENT_HISTORY";
  completeness: number;      // 0..1
  quality: QualityEnvelope;  // existing type
  provider: ProviderId | null;
  providerChain: ProviderId[];
  requestedAt: string; dataTimestamp: string | null; receivedAt: string;
  staleAge: number | null;
  coverageStart: string | null; coverageEnd: string | null;
  missingIntervals: Array<{ from: number; to: number }>;
  warnings: string[]; errors: string[];
};

// e.g. getHistoricalCandlesWithStatus(req): Promise<DataAvailability<OHLCVCandle[]>>
```

Migrate consumers incrementally (signal engine first). This is the cleanest way
to satisfy brief §4 without destabilising every caller in one commit.

---

## 4. Residual risks (open, tracked in the gap report)

- G-06 / G-07: candle `volume ?? 0` and synthesized intraday volume=0 should be
  flagged like OI (medium; volume-0 is frequently benign).
- G-10: `allowStaleTicks` should thread the `synthetic`/stale flag to `onTick`
  (type now supports it).
- G-12/G-13: `instrument-master` swallow and `getQuotes` all-null need typed
  failure markers.
- Trust-through: `scrapling` provider should re-validate candle OHLC locally.
- Rate limiting on NextApi / Upstox in the Python service.

---

## 5. Verification performed this pass

- `tsc --noEmit` (app) — **PASS**
- `tsc --noEmit -p worker/tsconfig.json` — **PASS**
- `vitest run tests/lib` — **1780 passed**
- `vitest run tests/features tests/services tests/worker` — **885 passed**
- `data-service` `pytest tests/` — **671 passed, 18 skipped**
- `python -m py_compile` on all changed Python — **OK**
- `eslint` on all changed TS — **0 errors** (pre-existing warnings only)
- Pydantic instantiation of `OptionContract` with new flags — **OK**

Prisma migration was **not** run (no schema change was applied; the INFRA models
above are proposals awaiting review, per the safety guardrail on schema changes).

---

## 6. Final statement

Do not describe this system as "data production-ready." The correct status is:

> **DATA_DEGRADED**, with the most dangerous integrity defects **remediated**
> (no more fabricated OI/volume zeros; no more delayed-as-live quotes; stronger
> validation; observable drops/outages), and a clear, additive path (INFRA
> §3) to **DATA_READY** once the gap/incident/version models and the
> DataAvailability envelope are in place and real coverage numbers are measured
> in a live session.
