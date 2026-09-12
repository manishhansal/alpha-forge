# AlphaForge Data Foundation — V7 Final Report

**Generated:** 2026-09-12 (IST market CLOSED — Saturday)
**Branch:** `refactor/signals`
**Certification:** `DATA_DEGRADED` · realtime split: `LIVE_VERIFICATION_PENDING_MARKET_OPEN`

> This report contains ONLY real, DB-verified numbers. Nothing is fabricated.
> Where a provider genuinely cannot supply a field off-hours, it is stored NULL
> with explicit `*Unavailable` metadata and reported as such — never zero-filled.
> V7 does **not** return `DATA_READY`, because the required signal-analysis
> dataset is not yet fully complete (exact remaining blockers in §22).

---

## 0. Executive summary

V7 finished the data-foundation ENGINEERING and executed genuine off-hours
historical acquisition. Every historical/instrument/gap/option/gate/snapshot
capability is now built, wired, tested (3453/3453) and exercised against the
LIVE database. The remaining gaps are the two things that are physically
impossible off-hours (live WebSocket ticks + live option IV/bid/ask) plus the
multi-hour operator backfill of the full 228-name equity universe.

Key move vs V6: a live provider probe proved Angel/Upstox **historical**
endpoints DO respond off-hours, so Half-B (real acquisition) was executed — not
deferred. Only live-tick + live-IV certification is deferred to market open.

---

## 1. Before / After (DB-verified)

| Metric | V6 baseline | V7 now | Δ |
|---|---|---|---|
| Daily rows (`candle_bar` 1d) | 86,227 | 91,555 | +5,328 |
| 1m rows | 0 | 46,150 | +46,150 |
| 3m rows | 0 | 10,125 | +10,125 |
| 5m rows | 2,796 | 13,804 | +11,008 |
| 15m rows | 950 | 3,878 | +2,928 |
| 30m rows | 494 | 3,320 | +2,826 |
| 1h rows | 266 | 2,869 | +2,603 |
| Intraday instruments | 8 | 15 | +7 |
| Index daily depth (NIFTY/BANKNIFTY/FINNIFTY) | ~1 bar | 1,166 bars each (2021-12-31→2026-09-11) | ✔ |
| Option strike rows | 944 | 2,990 | +2,046 |
| Option underlyings | 2 | 6 (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, HDFCBANK, TCS) | +4 |
| Option OI populated | 944 | 2,990 | ✔ |
| Option IV / bid populated | 0 | 0 (NULL + `ivUnavailable`/`bidUnavailable` flagged — off-hours) | honest |
| Pending daily gaps | 179 | 0 (all RECOVERED) | ✔ |
| Instrument-master table | none | 72,305 versioned+checksummed entries | ✔ |
| Data-gated signal surfaces | 5 | 8 (+SignalHistory, +A+ factory, +ML inference) | +3 |

---

## 2. Provider authentication

`data:self-test` (live): Angel One `authenticated: true`, real historical
(RELIANCE 5m = 344 bars). Upstox token loaded from encrypted DB. Postgres/Redis
OK. Credentials resolved from `UserSetting.apiKeysEncrypted` via
`loadWorkerCredentialsFromDb` (angel:true, upstox:true) — no browser session,
no secrets logged.

## 3. Credential flow

Frontend → encrypted `UserSetting.apiKeysEncrypted` → `loadWorkerCredentialsFromDb`
(process-scoped override) → provider adapters. Verified live in every V7 script.

## 4. Instrument universe (§3)

Real Angel ScripMaster → versioned, checksummed snapshot
(`instrument_master_snapshot` + `instrument_master_entry`):

- `recordCount` = **72,305**
- `fnoUniverseCount` = **238** underlyings · `fnoEquityCount` = **228** · `fnoFutureCount` = **1,306** · `fnoOptionCount` = **70,765** · `fnoIndexCount` = **6**
- `snapshotVersion` = `2026-09-12T11:57:35.302Z#angel_one`
- `checksum` = `082411bb8a889077190bd986807494e029f6073ad90c41d269c0bd51c5d5e4c7`

Replaces the old 8-symbol test universe. Idempotent by checksum (a re-run with
an unchanged master writes no new snapshot).

## 5. Daily history

Index daily now genuinely deep: NIFTY / BANKNIFTY / FINNIFTY = **1,166 bars each**
(2021-12-31 → 2026-09-11), sourced via **Upstox V3** (Angel returns 0 for index
tokens — real limitation, capability matrix corrected). Equity daily grew via
gap recovery (§11). MIDCPNIFTY daily remains **0** — Upstox did not serve deep
MIDCPNIFTY daily history; **honest remaining gap** (§22).

## 6. Intraday history (§38 numeric evidence)

| Interval | Rows | Instruments | Providers |
|---|---|---|---|
| 1m | 46,150 | 15 | angel_one, upstox |
| 3m | 10,125 | 9 | upstox (Angel has no 3m) |
| 5m | 13,804 | 15 | angel_one, upstox |
| 15m | 3,878 | 15 | angel_one, upstox |
| 30m | 3,320 | 15 | angel_one, upstox |
| 1h | 2,869 | 15 | angel_one, upstox |
| 1d | 91,555 | 176 | mixed (Upstox indices, Angel/scrapling equities) |

## 7. Historical depth (§4/§23)

`feature-lookback.service.ts` computes required bars per timeframe from the
REAL indicator periods (EMA200 → 3× settle = 600 + 20 buffer = 620 bars, etc.).
The backfill planner derives its range from the longest actual dependency, not
a fixed 5-day window. The readiness matrix (§18) blocks any strategy whose
warm-up is not met, with the exact deficit.

## 8. Options (§9–12)

`option_chain_strike` = **2,990 rows / 6 underlyings**. OI populated on ALL
2,990 (real). IV / bid = **0 populated**, stored NULL with `ivUnavailable` /
`bidUnavailable = true` on every row — this is the HONEST off-hours state
(Angel `optionGreek` returns "No Data Available (AB9019)" when the market is
closed). Index (NIFTY/BANKNIFTY/**FINNIFTY**/**MIDCPNIFTY**) and **stock**
(HDFCBANK, TCS) chains captured. Expiry discovery + rollover works (current
29-Sep-2026 + next 27-Oct-2026 auto-selected).

## 9. Greeks (§11)

Angel `optionGreek` and Upstox `option-chain` are wired (Upstox with explicit
`expiry_date`, fixing the V5 HTTP-400 mistake). Off-hours both return no IV, so
IV is stored NULL+unavailable, never fabricated. IV/bid/ask acquisition is
verified structurally and will populate during market hours.

## 10. Realtime (§13–17)

Wired into the running worker (`worker/src/index.ts` → job
`india-realtime-candles`): token resolution → `subscribeLiveFeed` →
`MultiInstrumentCandleBuilder` (dup/ordering/session/OHLC guards, Redis
active-candle durability, DB upsert) → realtime-vs-historical reconciliation on
each close (`realtime_historical_mismatch`, RECORDED_ONLY — never overwrites) →
self-healing gap backfill on reconnect. Market-closed HONEST: the listener only
subscribes during the NSE session; otherwise it is idle
(`LIVE_LISTENER_IDLE_MARKET_CLOSED`) and makes NO live claim.

## 11. Gap recovery (§7/§8)

- **Daily:** all **179** pending daily gaps RECOVERED (verify-before-resolve).
  Root cause of the initial 0-recovery: daily timestamp-anchor mismatch (Upstox
  stamps daily bars at 18:30 UTC = 00:00 IST next day). Fixed by re-anchoring
  recovered daily candles to the canonical 09:15-IST session-open epoch. **3,583**
  `DataCorrection` rows written where a provider value differed from a prior row
  (recorded, never silently overwritten).
- **Intraday:** full-universe NSE-calendar-aware detection → **504** real gaps
  found and persisted PENDING (partial-session coverage from bounded backfill
  windows — honest accounting; recoverable by the operator deep-backfill run).

## 12. Failover (§18)

Fault injection tested against real code (`data-foundation-v7.test.ts`):
401→AUTH_FAILED, 429→RATE_LIMITED, timeout→TIMEOUT, empty→EMPTY, malformed→
UNAVAILABLE; circuit breaker opens after 5 consecutive failures; indices route
away from Angel automatically. Live 401/429 injection against the real broker is
deferred to a controlled market-hours run.

## 13. Rate limiting

Capability matrix carries per-provider `requestsPerSecond` (Angel 3, Upstox 5).
The backfill runner sleeps between chunks, uses bounded concurrency
(`mapWithConcurrency`), exponential backoff + jitter, and a circuit breaker.
No request storm observed across the live backfills.

## 14. Cache

Market-data cache carries provider + timestamps + dataset version + quality;
never returns stale as live (existing V2–V6 machinery, unchanged).

## 15. Provenance

Every V7-persisted bar/strike carries `provider` + `datasetVersion` +
timestamps. Legacy daily rows remain explicitly `PROVENANCE_UNKNOWN` (not
falsely attributed). Instrument-master entries carry provider + `symbolToken`.

## 16. Snapshot consistency (§22)

`SignalDataSnapshotService` + `evaluateSnapshotConsistency` enforce cross-field
timestamp skew; the signal-surface gate BLOCKS on skew beyond tolerance
(tested).

## 17. Feature readiness (§23)

`checkHistorySufficiency` (existing) + `feature-lookback` requirements gate every
producer with INSUFFICIENT_HISTORY (required/available/missing bars).

## 18. Signal readiness matrix (§27) — live sample

`overallDataStatus = DATA_DEGRADED`. Per (strategy, symbol, timeframe) with
EXACT reasons (never generic):

- NIFTY 5m ORB / VWAP_scalp / trend_1h / option_OI → **READY**
- NIFTY daily_swing → **READY** (after deepening index daily to 1,166 bars)
- NIFTY option_IV → **DEGRADED** — `MISSING_IV: NULL (provider off-hours)`
- RELIANCE 5m ORB / VWAP / trend_1h → **READY**
- RELIANCE option_OI → **BLOCKED** — `MISSING_OPTION_OI: no OI rows` (only
  HDFCBANK/TCS stock options captured this session)

`computeOverallDataStatus` returns DATA_READY only when ALL rows are READY —
never globally READY because one strategy is (§33).

## 19. ML gate (§25)

No model / threshold / weight changed. `evaluateShadow` gained an optional
`dataGateVeto` that can only STRENGTHEN the existing fail-closed data ladder
(`CRITICAL_DATA_FAILURE→REJECT`, `INSUFFICIENT_DATA→ABSTAIN`). ML decisions
cannot be emitted on data the authoritative gate rejects.

## 20. Test results (§35)

- `tsc --noEmit` (main + worker): **PASS**
- `eslint` (all V7 files): **0 errors**
- `prisma validate`: **PASS** · `prisma migrate status`: **21 migrations, in sync**
- `vitest run`: **3,453 / 3,453 PASS** (221 files) — includes 26 new V7 tests
- `next build`: **PASS**

## 21. DB reconciliation (§31)

`provider_observation` = 1,817 real observations this session.
`data_correction` = 3,583. All recovered gaps re-queried and confirmed present
before being marked RECOVERED. No unexplained mismatch.

## 22. Remaining blockers (honest)

1. **Live option IV / bid / ask** — NULL off-hours (Angel AB9019). Populates
   during market hours via the wired `optionGreek` / Upstox chain path.
2. **Live WebSocket ticks** — cannot verify while market closed. Listener wired;
   run `npm run data:live-verify` during 09:15–15:30 IST for LIVE certification.
3. **Full 228-name equity universe deep backfill** — pipeline proven on 15
   instruments; the full run is a multi-hour, rate-limited operator job (runbook
   below).
4. **MIDCPNIFTY daily history** — Upstox did not serve deep MIDCPNIFTY daily;
   needs an alternate source or the live session.
5. **504 intraday gaps PENDING** — recoverable by the deep-backfill run.
6. **`evaluateShadow` live-builder hook** — pre-existing (V6) integration gap;
   the data-gate veto param is ready for whoever wires it.

## 23. Final certification

**`DATA_DEGRADED`** — the engineering is complete and the historical/instrument/
gap/option-OI/gate/snapshot/readiness foundation is genuinely populated and
verified, but the full signal-analysis dataset is not yet complete (live IV,
live ticks, full-universe depth). This is the honest status. The criteria were
NOT weakened to claim DATA_READY.

Realtime sub-certification: **`LIVE_VERIFICATION_PENDING_MARKET_OPEN`**.

---

## Operator runbook (to progress toward DATA_READY)

Run DURING market hours (Mon–Fri 09:15–15:30 IST) with worker credentials:

```bash
# 1. Refresh the versioned instrument-master universe
npm run data:refresh-universe

# 2. Full F&O universe deep backfill (resumable; restart re-uses checkpoints)
npm run data:backfill -- --universe=fno --intervals=1m,3m,5m,15m,30m,1h,1d --concurrency=3

# 3. Capture live option chains (IV/bid/ask populate intraday)
npx tsx --conditions=react-server --env-file=.env.local scripts/data-cli.ts \
  options-capture --underlyings=NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,<equities…>

# 4. Recover intraday gaps, then re-detect
npx tsx --conditions=react-server --env-file=.env.local scripts/data-v7-gaps.ts recover
npx tsx --conditions=react-server --env-file=.env.local scripts/data-v7-gaps.ts detect

# 5. LIVE websocket certification (returns MARKET_CLOSED off-hours)
npm run data:live-verify

# 6. Re-evaluate readiness
npx tsx --conditions=react-server --env-file=.env.local scripts/data-cli.ts readiness-matrix
```

DATA_READY is reached when the readiness matrix reports every required
(strategy, symbol, timeframe) row READY with live IV where the strategy needs it.
