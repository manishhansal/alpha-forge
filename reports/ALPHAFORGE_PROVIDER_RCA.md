# AlphaForge — Provider / Data Foundation RCA Matrix

**Generated:** 2026-09-12 (Saturday — NSE closed) · Branch `refactor/signals`

Each row: **Issue → Root cause → Classification → Fix → Test → Verification.**
Classification legend: `ALPHAFORGE_BUG` (fixed this pass), `PROVIDER_LIMITATION`,
`OPERATOR_WORK`, `MARKET_CLOSED`.

---

## FIXED THIS PASS

### RCA-1 — Provider failure returned as valid empty quote data (§4)
- **Issue:** `getQuotes` returned an all-null array on failure; a caller could
  not tell "provider failed" from "symbols unresolved", and `withFailover` never
  advanced to the next provider (it only fails over on a thrown error).
- **Root cause:** `ALPHAFORGE_BUG`.
  - `angel-one.ts` `getQuotes` `catch → return symbols.map(() => null)`.
  - `upstox.ts` `_fetchQuotes` swallowed per-chunk errors into `null` slots.
  - `upstox.ts` `getQuotes`/`getLatestQuote` returned `null` when not configured.
- **Fix:**
  - `health.ts`: added `failureKindToErrorCode()`.
  - `angel-one.ts` `getQuotes`: throws typed `MarketDataError(code)` (health
    still recorded first).
  - `upstox.ts` `_fetchQuotes`: throws typed error only when **all** chunks
    failed and nothing resolved; genuine PARTIAL preserved.
  - `upstox.ts` `getQuotes`/`getLatestQuote`: throw `NOT_CONFIGURED`;
    `getQuotes([])` → `[]`.
- **Test:** `angel-one-provider.test.ts` (auth→`AUTH_FAILURE`; generic→typed
  throw; `getLatestQuote` network→rejects), `upstox-provider.test.ts`
  (not-configured→rejects `/not configured/i`), `failover.test.ts` (throw→next
  provider).
- **Verification:** 208/208 affected + 953/953 broad vitest; `tsc` main+worker PASS.

### RCA-2 — evaluateShadow not gated by the authoritative data gate (§21)
- **Issue:** A+ factory + ML decision path were gated only by the candidate's
  self-reported flags, not by the DB-backed authoritative gate.
- **Root cause:** `ALPHAFORGE_BUG` — `evaluateShadow`'s `dataGateVeto` param had
  no production caller.
- **Fix:** new `src/lib/india/shadow-data-gate.ts`
  (`deriveDataGateVeto` + `evaluateShadowWithDataGate`) evaluates
  `evaluateSignalSurfaceDataGate` first (fail-closed) and passes the veto in.
  Veto can only strengthen the block; no EV/probability/score/ML change.
- **Test:** `tests/lib/india/shadow-data-gate.test.ts` (healthy→allowed;
  critical `UNAVAILABLE`→`REJECT`/`CRITICAL_DATA_FAILURE`; snapshot skew→`REJECT`;
  no-deps→fail-closed `REJECT`; `AUTH_FAILED`→never `TRADE`).
- **Verification:** included in the 953-test broad run.

---

## NOT A BUG — CLASSIFIED, ROUTED AROUND, OR GATED PER-STRATEGY

### RCA-3 — Angel One 3-minute interval returns 0 bars
- **Root cause:** `PROVIDER_LIMITATION` — `getCandleData` has no `THREE_MINUTE`.
- **Handling:** capability matrix omits Angel 3m; 3m routes to Upstox. Never
  requested from Angel, never recorded as a false EMPTY.

### RCA-4 — Angel One returns 0 for index tokens
- **Root cause:** `PROVIDER_LIMITATION`.
- **Handling:** `historyProvidersForSymbol` drops Angel for index symbols; index
  history routes to Upstox v3 (`isIndexSymbol`).

### RCA-5 — Option IV / bid / ask are NULL
- **Root cause:** `MARKET_CLOSED` (Saturday; Angel `optionGreek` AB9019).
- **Handling:** fields are NULL with explicit `*Unavailable` flags (never 0).
  Only IV/bid-ask-dependent strategies degrade. Live cert `PENDING_MARKET_OPEN`.

### RCA-6 — MIDCPNIFTY deep daily history = 0
- **Root cause:** `PROVIDER_LIMITATION` — Upstox did not serve deep MIDCPNIFTY
  daily.
- **Handling:** recorded `DATA_UNAVAILABLE` with providers attempted; gate **only**
  MIDCPNIFTY-dependent strategies. Independent NIFTY/equity strategies unaffected
  (§28). Not fabricated, no random source added.

### RCA-7 — 504 intraday gaps pending
- **Root cause:** `OPERATOR_WORK` — deep backfill not yet executed.
- **Handling:** resumable `fno-backfill-runner.service.ts` + gap detect/recover;
  a gap is marked RECOVERED only after DB verification, else `UNAVAILABLE` with
  reason.

### RCA-8 — Live WebSocket ticks unverified
- **Root cause:** `MARKET_CLOSED`.
- **Handling:** worker wired (`india-realtime-candles`), idle off-hours
  (`LIVE_LISTENER_IDLE_MARKET_CLOSED` — no false live claim). Run
  `npm run data:live-verify` next session.

---

## Pre-existing lint (out of scope, untouched)
- `angel-one.ts:669` — `require()`-style import inside WS subscribe code. This is
  pre-existing and outside the quote path changed here; left unmodified to keep
  the change surgical.
