# ALPHAFORGE — DATA FOUNDATION V4 INTRADAY REPORT

Real DB state, queried 2026-09-11.

| provider | interval | history depth | rows | coverage | gaps | latency | status |
|---|---|---|---|---|---|---|---|
| — | 1m | 0 sessions | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 3m | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 5m | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 10m | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 15m | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 30m | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |
| — | 1h | 0 | 0 | 0 | n/a | n/a | DATA_INSUFFICIENT |

**No intraday candles are persisted.** Root cause (D-V4-06): the only enabled
provider (data-service/scrapling) serves current-day intraday only; the
multi-day-history providers (Angel One, Upstox) have no credentials, and the
market was closed at run time.

## Pipeline evidence (from V3, re-confirmed)
- Backfill orchestrator (resumable/chunked/idempotent/checkpointed): IMPLEMENTED
  + TEST-VERIFIED + DB-VERIFIED (a hard-failed chunk does NOT advance the
  checkpoint — regression-protected). Write-through persistence + provenance
  stamping: IMPLEMENTED. `sessionDate` now stamped on all new writes (V4).
- 1m→HTF aggregation: IMPLEMENTED + TEST-VERIFIED (drops incomplete buckets →
  PARTIAL; lineage recorded; §47/§49 compliant).

## What would happen with credentials
Configure `SMARTAPI_*` (Angel One is the primary multi-day intraday source; ~3
req/s historical cap in the capability matrix) or `UPSTOX_*`, then run the
backfill for the controlled subset (NIFTY/BANKNIFTY/RELIANCE/HDFCBANK/ICICIBANK/
INFY/TCS). The pipeline will persist real bars with full provenance + sessionDate
and the coverage/gap engines will report real numbers.

**Certification:** intraday pipeline is IMPLEMENTED + TEST-VERIFIED + (demo)
DB-VERIFIED; **real persisted intraday = DATA_INSUFFICIENT** and
**LIVE_RUNTIME_VALIDATION_NOT_AVAILABLE** until a credentialed history provider
supplies real bars.
