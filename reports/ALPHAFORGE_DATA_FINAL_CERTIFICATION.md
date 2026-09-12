# AlphaForge — Data Foundation Final Certification

**Generated:** 2026-09-12 (Saturday — NSE closed)
**Branch:** `refactor/signals`
**Overall status:** `DATA_DEGRADED`
**Scope of this pass:** capability-aware provider-failure semantics (§4) and the
authoritative data-gate ↔ `evaluateShadow` runtime wiring (§21), plus TDD tests
and full verification. This is an engineering pass, **not** a fresh full-universe
acquisition run.

> **Honesty statement.** This document reports only what was implemented and
> verified in this session, plus what was carried forward from the V7 DB probe
> (clearly labelled). No market data was fabricated. No readiness gate was
> weakened. No ML model or threshold was changed. Items that can only be proven
> during an NSE session are flagged `PENDING_MARKET_OPEN` — they are not claimed
> as verified.

---

## 1. What this pass changed (root-cause fixes)

### §4 — Provider failure must never look like valid empty quote data

**Root cause (confirmed by reading the adapters).** The quote path conflated a
provider *failure* with a legitimate *empty/unresolved* result, and — because
`withFailover` only fails over on a thrown error — it also silently suppressed
failover:

| File | Old behaviour | Why it was a bug |
| --- | --- | --- |
| `providers/angel-one.ts` `getQuotes` | `catch → return symbols.map(() => null)` | All-null is indistinguishable from "symbols unresolved"; `withFailover` saw a resolved value and never tried Upstox. |
| `providers/upstox.ts` `_fetchQuotes` | per-chunk `catch` swallowed the error, leaving `null` slots | A total failure returned all-null (same conflation + no failover). |
| `providers/upstox.ts` `getQuotes` / `getLatestQuote` | `!isUpstoxAvailable() → return null` | "Not configured" looked like empty data; failover never advanced. |

**Fix.**
- Added `failureKindToErrorCode()` in `market-data/health.ts` (inverse of the
  existing `codeToFailureKind`).
- `angel-one.ts` `getQuotes` now **throws a typed `MarketDataError`** carrying the
  classified code on failure (still records health first).
- `upstox.ts` `_fetchQuotes` tracks chunk outcomes and throws a typed error
  **only when every chunk failed and nothing resolved** — a genuine PARTIAL
  (some chunks succeeded) is preserved and returned.
- `upstox.ts` `getQuotes`/`getLatestQuote` throw `NOT_CONFIGURED` (was silent
  null) so the chain fails over. `getQuotes([])` still returns `[]`.

**Effect.** A provider failure now (a) triggers real failover to the next
*capable* provider, and (b) reaches `getQuotesWithStatus`, which already stamps
each symbol with `AUTH_FAILED` / `RATE_LIMITED` / `INVALID` / `PROVIDER_FAILED`.
A genuine unresolved symbol from a *successful* call still returns `null`
(`UNRESOLVED`) — the two are now distinguishable.

### §21 — `evaluateShadow` live-builder / data-gate integration

**Root cause (confirmed).** `evaluateShadow` already accepted a `dataGateVeto`
param that OR-s into `criticalDataIssue` / `insufficientData` (feeding
`resolveCanonicalDecision`), but **nothing in production computed or passed it**.
The A+ factory and the ML decision path were therefore gated only by the
candidate's self-reported flags, not by the authoritative DB-backed gate.

**Fix.** New `src/lib/india/shadow-data-gate.ts`:
- `deriveDataGateVeto(gate, deps)` → `{ blocked, insufficient, reason? }`.
- `evaluateShadowWithDataGate(candidate, artifact, gateInput, cluster?)` —
  evaluates `evaluateSignalSurfaceDataGate` (fail-closed, never throws) **first**,
  derives the veto, then calls `evaluateShadow` with it.

**Effect.** The authoritative gate can only *strengthen* the veto — a
blocked/insufficient/ inconsistent snapshot forces the canonical decision to
`REJECT`/`ABSTAIN`. It never relaxes a gate and never touches EV / probability /
score. This is the production entry point the live builder / worker should call.

---

## 2. Provider health & capabilities

Capability is sourced from the authoritative in-code matrix
(`provider-capability-matrix.ts`) — see
`ALPHAFORGE_PROVIDER_CAPABILITY_MATRIX.json`. Key verified facts (live-probed
2026-09-12 per V7, encoded in the matrix):

- **Angel One:** equity 1m/5m/15m/30m/1h/1d history + live; **no 3m**
  (`getCandleData` has no `THREE_MINUTE`); returns 0 for index tokens.
- **Upstox v3:** equity **and index** history/live for 1m/3m/5m/15m/30m/1h/1d;
  minute intervals capped to small per-request windows. The capable 3m + index
  source.
- **Yahoo:** last-resort equity fallback only; **never** options.
- **scrapling (data-service):** daily + current-day intraday only; no multi-day
  intraday history.

`UNSUPPORTED_CAPABILITY`, `AUTH_FAILURE`, `RATE_LIMIT`, and `MARKET_CLOSED`
remain distinct from generic failure in the classifier (`failover.ts`
`classifyError` + `health.ts` `FailureKind`).

## 3. Provider failover

`withFailover` (`market-data/failover.ts`) retries within a provider (bounded,
backoff + jitter, Retry-After aware, circuit-breaker aware) then advances to the
next *capable* provider. The §4 fix means the real adapters now feed this engine
correctly. Deterministic failover is proven by `tests/lib/market-data/failover.test.ts`
(throw → next provider, circuit-open skip, cooldown).

## 4. Authentication & credential flow

Unchanged this pass. The V7-certified path (frontend encrypted DB creds →
`worker-credentials.ts` loader → provider auth) remains. Angel auth + Upstox v3
were live-verified in the V7 session; not re-run today (market closed).

## 5–14. Universe / coverage / options / gaps / realtime

**Carried forward from the V7 DB probe (NOT re-verified this session).** See
`ALPHAFORGE_DATA_COVERAGE_MATRIX.json`. Summary: 72,305 instruments; daily
91,555 rows / 176 instruments; intraday across 15 instruments; option OI 2,990
strikes real. Off-hours: option IV/bid/ask NULL (honest); live WS unverifiable.

## 15–20. Rate limiting, observability, quality, snapshot, data gate

Unchanged and intact. The canonical fail-closed gate
(`signal-surface-data-gate.service.ts`) is now reachable by the A+ factory + ML
path through the new `shadow-data-gate.ts` wiring (§21).

## 21. evaluateShadow integration — **CLOSED** this pass (see §1).

## 22–24. SignalHistory / ML / DB integrity

SignalHistory ingest was already gated (V7). ML models/thresholds **unchanged**.
No schema/migration changes this pass (`prisma validate` PASS; 21 migrations,
unchanged).

## 25. Tests

- **New:** `tests/lib/india/shadow-data-gate.test.ts` (veto derivation + full
  fail-closed wiring: healthy→allowed; critical UNAVAILABLE→REJECT; snapshot
  skew→REJECT; no-deps→fail-closed REJECT; AUTH_FAILED→never TRADE).
- **Updated:** `angel-one-provider.test.ts` + `upstox-provider.test.ts` — the
  tests that previously asserted the buggy all-null now assert the typed throw.

## 26. Market-hours certification — `PENDING_MARKET_OPEN`

Live WebSocket ticks, live option IV/bid/ask cannot be certified on a Saturday.
Run `npm run data:live-verify` during 09:15–15:30 IST on the next NSE session.

## 27. Coverage report

See `ALPHAFORGE_DATA_COVERAGE_MATRIX.json` (DB-derived, carried from V7).

---

## Verification evidence (this session)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (main) | `npx tsc --noEmit` | **PASS** (exit 0) |
| Typecheck (worker) | `npx tsc --noEmit -p worker/tsconfig.json` | **PASS** (exit 0) |
| Unit tests (affected) | `vitest run` 6 suites | **208/208 pass** |
| Unit tests (broad) | `vitest run tests/lib/market-data tests/lib/india` | **40 files, 953/953 pass** |
| Prisma schema | `prisma validate` | **PASS** |
| Migrations | folder count | 21 (unchanged; 0 added this pass) |
| ESLint (my regions) | `eslint <changed files>` | clean; one **pre-existing** `require()` error at `angel-one.ts:669` (untouched WS code) |

> `npm run build` runs `prebuild = npm test` (full suite) + Next build; not run
> end-to-end this session. The affected + neighbouring suites (953 tests) pass.

---

## 28. Remaining blockers & exact RCA

See `ALPHAFORGE_PROVIDER_RCA.md`. Summary of what keeps overall status at
`DATA_DEGRADED` (all honest, none fabricated):

1. **Live option IV/bid/ask NULL** — market closed (Saturday). `MARKET_CLOSED`,
   not a bug. Populates during session.
2. **Live WebSocket tick verification** — `PENDING_MARKET_OPEN`.
3. **Full 228-name equity deep backfill** — multi-hour operator run; resumable
   runner exists (`fno-backfill-runner.service.ts`).
4. **MIDCPNIFTY deep daily** — Upstox did not serve deep history; recorded
   `DATA_UNAVAILABLE`; gate only MIDCPNIFTY-dependent strategies.
5. **504 intraday gaps** — pending; recoverable by the deep-backfill + gap runner.

Per §28, none of these globally block independent strategies (NIFTY ORB,
RELIANCE VWAP, BANKNIFTY intraday remain independently evaluable).

## 35. Final certification rule

**`DATA_DEGRADED`.** Historical/instrument/gap/option-OI/gate/snapshot foundation
is genuinely populated (V7) and the two remaining code-level gaps this task
targeted (§4, §21) are now fixed and tested. `DATA_READY` is withheld because
live IV/bid/ask + WS require an NSE session, and the full deep backfill /
MIDCPNIFTY history are operator/market items — not because any gate was weakened.
