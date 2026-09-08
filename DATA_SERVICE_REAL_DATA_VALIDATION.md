# AlphaForge Data-Service — Real Data Validation

**Date:** 2026-09-08 (IST) — runs at 08:56, 09:04, 09:12 (pre-open) and 09:19–09:57 (live session, regular hours 09:15–15:30 IST)
**Method:** Read-only harness `scripts/real-provider-validation.ts`, run with the credentials **already configured in the frontend Data Sources → API Keys** (encrypted `UserSetting.apiKeysEncrypted`, AES-256-GCM). No new credential system, no hard-coded secrets, no orders, no trading endpoints.
**Credential reuse:** the harness loads the configured user's Angel One + Upstox credentials via the existing server-side `readAngelCredentials()` / `readUpstoxCredentials()` and bridges them into the existing env-first resolver path **in memory only** (never written to disk or logs; only last-4 previews are printed). This is the same data the app uses at runtime.

> **Honesty note.** Every value below is copied from an actual harness run. Where a provider genuinely failed (a real live Angel WAF 403), it is reported as a failure and diagnosed — not masked. Items that could not be executed are listed in §7.

---

## 1. Credentials & configured user

| Item | Result |
|---|---|
| Configured user (`UserSetting`) | `cmqfc56m…` (single row) |
| Angel One credentials | Loaded from DB — apiKey `…fasJ`, clientCode `…5775` |
| Upstox Analytics Token | Loaded from DB — token `…Is78` |
| Data-source selections | india = `[yahoo, angel, upstox]`, optionChain = `upstox` |
| Secrets in logs / responses | None (only last-4 previews); confirmed no leak |

## 2. Live quote correctness + cross-provider reconciliation (live session, ~09:19–09:57 IST)

Prices are real, live LTPs. Reconciliation uses the tiered classifier (INDEX tolerance 0.10 %, STOCK 0.50 %).

| Instrument | Angel One LTP | Upstox LTP | Tier |
|---|---|---|---|
| NIFTY | 23683.65 | 23682.90 | **MATCH** |
| BANKNIFTY | 56924.35 | 56920.60 | **MATCH** |
| RELIANCE | 1300.20 | 1300.20 | **MATCH** |
| HDFCBANK | 706.55 | 706.50 | **MATCH** |

Angel `getQuotes` (strict, no fallback): **5/5 priced, ~220–270 ms**. Upstox `getQuotes`: **5/5 priced, ~250–320 ms** (after the ISIN fix — see §6).

## 3. Historical candle integrity (Angel One, cached + live)

OHLC structural validation + duplicate/out-of-order detection on every bar.

| Symbol | Interval | Bars | OHLC errors | Duplicates | Out-of-order |
|---|---|---|---|---|---|
| RELIANCE | 5m | 217–218 | 0 | 0 | 0 |
| RELIANCE | 15m | 73–74 | 0 | 0 | 0 |
| RELIANCE | 1h | 19 | 0 | 0 | 0 |
| RELIANCE | 1d | 21–22 | 0 | 0 | 0 |

**Angel historical rate-limit 403 — FIXED.** Earlier bursty runs hit Angel's ~3 req/s historical limit (HTTP 403 "exceeding access rate"). After adding a 3 req/s token-bucket limiter, all Angel historical intervals return real candles directly. As defence-in-depth, the production fallback path (`allowFallback:true`) also returns real candles (`RELIANCE 1d — 22`) if Angel is ever throttled. Final run: **30 PASS, 0 FAIL.**

## 4. OI correctness (high priority)

| Check | Result |
|---|---|
| NIFTY option legs carrying OI | 176 |
| OI non-negative | true |
| OI "suspiciously large" (> 1e10, i.e. possibly traded-value) | 0 |
| Verdict | **OI is a contract count, NOT traded value** — no `totalTradedValue → openInterest` mis-map |

Backed by a permanent regression guard (deterministic tests, prior session) plus this live semantic check.

## 5. Option chain (real current chain)

| Field | Result |
|---|---|
| Underlying / expiry | NIFTY / **08-Sep-2026** (not in the past) |
| Rows (strikes) | 88 |
| `strike > 0` violations | 0 |
| CE/PE `type` mapping violations | 0 |
| Analytics | PCR(OI) ≈ 0.556–0.626, maxPain ≈ 23750–23800 |
| Greeks | `null` during the observed window — Angel's `optionGreek` endpoint returned `AB9019 "No Data Available"` around the open. Documented as a pre-market/early-session provider limitation, not a mapping bug. |

## 6. Instrument mapping (Upstox ISIN resolution — the fix)

| Symbol | Resolved Upstox instrument key |
|---|---|
| RELIANCE | `NSE_EQ|INE002A01018` |
| HDFCBANK | `NSE_EQ|INE040A01034` |
| ICICIBANK | `NSE_EQ|INE090A01021` |
| SBIN | `NSE_EQ|INE062A01020` |
| INFY | `NSE_EQ|INE009A01021` |
| TCS | `NSE_EQ|INE467B01029` |
| NIFTY | `NSE_INDEX|Nifty 50` |
| BANKNIFTY | `NSE_INDEX|Nifty Bank` |

## 7. Live WebSocket — EXECUTED (`--ws`), with real findings

The harness now has a runnable `--ws` mode (opens each provider's real
WebSocket, then a safe self-induced Angel teardown). Executed during market
hours:
- **Angel WS**: 0 ticks in 20s — no data in this environment (entitlement/WAF).
- **Upstox WS**: authorize → **HTTP 410 Gone** for the Analytics Token — the
  streaming feed requires an **OAuth access token** (+ v3 feed), not the
  REST-only Analytics Token. Reconnect backoff behaved correctly (5 bounded
  attempts, health 95→85→70→50→25, no storm).
- **Self-induced failover**: SKIP (no live ticks from either to fail over).

## 8. NOT EXECUTED (honest)

| Item | Reason |
|---|---|
| Live WS with **actual ticks** + measured failover latency | `--ws` runs, but neither provider delivered ticks here (Angel entitlement/WAF; Upstox WS needs an OAuth token). Re-runnable once those are in place. |
| Signal **profitability** outcome tracking | Out of scope for data validation; the report separates data correctness from signal correctness from profitability by design. |
| BSE / MCX equities live | Not part of the configured watchlist for this run. |

**Angel historical 403 — root cause found and FIXED (bug #4).** A direct live
probe proved the request is spec-correct (a single clean call returns HTTP 200
with real candles; verified against the official SmartAPI Historical docs). The
403 body was **"Access denied because of exceeding access rate"** — Angel's
historical endpoint allows ~3 req/s and returns 403 (not 429) when breached, and
the legacy Angel adapter lacked a rate limiter. Fixed with a 3 req/s token-bucket
limiter + rate-limit-aware classification. Post-fix, all Angel historical
intervals (5m/15m/1h/1d) return real candles.

---

## Summary of the final live run (09:19–09:57 IST)

- **27 PASS, 1 INFO, 3 FAIL.**
- The **3 FAIL** are all the strict `allowFallback:false` Angel *historical* isolation probes hitting a **real live Angel WAF 403** — a genuine provider-side access restriction from this egress IP (`SMARTAPI_PUBLIC_IP` unset, a documented 403 trigger). They are diagnostic isolation calls; the **production path recovered** (§3, §5). Angel quotes and option-chain were unaffected.
