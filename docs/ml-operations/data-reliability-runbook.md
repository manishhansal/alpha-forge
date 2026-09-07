# Data-Reliability Operations Runbook (Phase 3Q)

Operational guide for the `ml-service/src/data_reliability/` layer: what each failure
mode means, how it surfaces, and what an operator should do. This layer is an
**authoritative upstream gate** — when it says data is not safe, downstream inference
and signals are suppressed (fail-closed).

## Operational failure modes

| Condition | Detected by | Surfaces as | Operator action |
|-----------|-------------|-------------|-----------------|
| Provider timeout / network error | `ProviderFailure.NETWORK_FAILURE` | fallback to next provider; retryable | Check provider health; no manual action if fallback succeeds |
| Provider throttled | `ProviderFailure.RATE_LIMITED` | `RateLimiter` denies; bounded retry | Reduce request rate; verify token-bucket config |
| Auth/token rejected | `ProviderFailure.AUTH_FAILURE` | NOT retried, NOT fallback-silenced | Rotate/refresh the provider credential (server-side only) |
| Empty (but healthy) answer | `ProviderFailure.NO_DATA` | NOT a failure, NOT fallback-eligible | None — genuine no-data (e.g. illiquid instrument) |
| Cross-provider disagreement | `check_provider_consistency` → `PROVIDER_CONFLICT` | DQ verdict `CONFLICT`, signal suppressed | Investigate which provider is wrong; do NOT pick favourable |
| Frozen / repeated feed | `detect_frozen_feed` → `DATA_STALE` | DQ `STALE`, signal suppressed | Restart/repoint the feed; check upstream ticker |
| Timestamp regression | `detect_timestamp_regression` | `DATA_STALE` | Feed ordering bug upstream; quarantine batch |
| Future timestamp / clock skew | `assess_staleness` → `FUTURE_TIMESTAMP` | `DATA_STALE` | Fix clock sync (NTP) on ingest host |
| Missing bars | `assess_completeness` → `INCOMPLETE` | DQ `INCOMPLETE`, signal suppressed | Backfill from provider; never fabricate |
| Forming last bar | `classify_last_bar_state` → `FORMING_BAR` | signal `NO_DECISION` | Wait for bar close — expected intrabar |
| Bad OHLC | `sanitize_bars` → quarantine | DQ `INVALID` | Inspect quarantined `RepairRecord.original` |
| Mixed adjustment mode | `assert_same_mode` raises | pipeline error (fail-closed) | Ensure all series share one adjustment basis |
| Historical lot unavailable | `validate_fno_metadata` → `FNO_LOT_SIZE_UNAVAILABLE` / `DATA_INSUFFICIENT` | signal `NO_DECISION` | Load PIT instrument-master history; never use today's lot |

## Alert severity policy (`alerts_ext`)

- Delayed / missing / rate-limited → **WARNING**
- Cross-provider conflict / provider outage → **ERROR**
- Invalid prices reaching a decision → **CRITICAL**
- Stale data producing a decision → **CRITICAL**
- Recovered → **INFO**

Every `DataAlert` names the **instrument, provider, and session** so an on-call
engineer can locate the problem. Phase 3Q severities map onto the existing
`monitoring.AlertSeverity` (which lacks `ERROR`) via `to_monitoring_severity`
(ERROR/CRITICAL → CRITICAL).

## Data-health endpoint

`health.DataHealthReport.to_dict()` produces the operator dashboard payload
(selected provider, market/ingestion timestamps, DQ verdict, missing-bar count, stale
instruments, conflicts, schema version). It **refuses to serialise** (raises) if any
credential-shaped value is present — a hard fail-closed guard against secret leakage.

## Security

- Broker credentials (`SMARTAPI_*`, `UPSTOX_*`) are **server-side environment only**
  and never sent to the browser. There are **no `NEXT_PUBLIC_*` broker/secret vars**.
- `security.redact_mapping` / `redact_headers` / `redact_text` scrub credential-shaped
  keys, auth headers, and bearer/JWT tokens from any logged/emitted payload. Redaction
  replaces the value with `***REDACTED***` and never echoes the secret.
- All observability events (`events.EventLog`) redact metadata at emit time.

## Recovery scenarios

- **Restart after partial ingest:** `IdempotentIngest` reloads its append-only ledger;
  replayed keys are no-ops, so no duplicate records after a crash mid-batch.
- **Cache staleness/corruption:** `CacheStore.get` returns a typed non-hit
  (STALE / CORRUPT / *_MISMATCH); the caller refetches — a stale entry never overrides
  a fresh one.
- **Correction after the fact:** append a `CORRECTED` revision; replay at an earlier
  `as_of` still reproduces the state that was available then.

## Approximations (see the audit doc for full detail)

- Muhurat dates are a hardcoded set — extend per year.
- Retry backoff does no real sleep by default; a production caller must inject one.
- The current-day harness is paper/shadow only and never trades.
- Real-provider validation is not exercised here (no live creds in this environment).
