# ALPHAFORGE PERSISTENCE VALIDATION

**Date:** 2026-09-09.

## Durable models + adapter

- `IndiaPredictionRecord` / `IndiaResolutionRecord` (Prisma) — full creation-time
  snapshot; unique `signalId` on both.
- `PrismaSignalRecordStore` implements `SignalRecordStore` with immutability +
  idempotency + P2002 normalisation.
- `shadow-persistence.ts` wires the store into the lifecycle:
  `persistShadowPrediction` (immutable) + `persistShadowResolution` (idempotent).

## Validated properties (tests)

| Property | Test | Result |
|---|---|---|
| Round-trip prediction lossless | prisma-signal-record-store | ✅ |
| Prediction immutable (2nd write rejected) | store + shadow + guards | ✅ |
| Resolution idempotent (no double-resolve) | store + shadow + guards | ✅ |
| Resolution requires existing prediction | store | ✅ |
| Net return = return − cost − slippage | shadow | ✅ |
| Ambiguous → conservative STOP_HIT + flag (never favorable) | shadow | ✅ |
| `persistShadowPrediction` no-throw on re-emit | shadow | ✅ |

## Migration

`prisma/migrations/20260909000000_add_india_prediction_resolution_records/migration.sql`
— CREATE TABLE/INDEX only (no drops). `prisma validate` ✅. Apply with
`prisma migrate deploy`. NOT applied to the local DB (which has an unrelated pending
migration not authored here).

## Status

Prediction persistence: **PASS** · Resolution persistence: **PASS** · Immutable
snapshots: **PASS** · Idempotency: **PASS**. The store is wired into the shadow path;
the live builder still needs to call `persistShadowPrediction` at signal creation and
`persistShadowResolution` at trade close (the P0 hook noted in the runtime report).
