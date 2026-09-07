# Phase 3N — Frontend / Security Audit (spec §42, §43, §55 Security, §64)

**Nature:** confirmation audit. No frontend code was rewritten. All findings are
first-hand (grep + code trace).

---

## A. No broker credentials reach the frontend / browser bundle (§42)

- `grep -rEn "NEXT_PUBLIC_[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|PIN|TOTP|CREDENTIAL)" src/`
  → **zero matches.** No secret is prefixed `NEXT_PUBLIC_`, so nothing is inlined
  into the client bundle by Next.js.
- The secret-touching modules (`src/lib/market-data/providers/upstox*`,
  `src/services/india/angelone/*`, `src/lib/env.ts`, the Upstox OAuth routes) have
  **no `"use client"` directive** — they are server-only route handlers /
  server modules. `grep -rln '"use client"' src/lib/market-data src/services/india`
  → **zero matches.**
- All broker secrets are read server-side via non-public `process.env.*`
  (`UPSTOX_ANALYTICS_TOKEN`/`UPSTOX_ACCESS_TOKEN`/`UPSTOX_CLIENT_SECRET`,
  `SMARTAPI_API_KEY`/`CLIENT_CODE`/`PIN`/`TOTP_SECRET`). The data-service Upstox
  client reads its token from env and its docstring asserts the token is never
  exposed to the browser; data-service CORS is restricted to `localhost:3000`.
- `grep` for `access_token|client_secret|refresh_token` inside JSON/response bodies
  in `src/app/api/in` → **zero matches.** The signal APIs return signals / scores /
  probabilities / EV / decision state / positions / health / provenance — never
  credentials.

**Verdict:** broker secrets in frontend = **NO**.

## B. No live-order path reachable from Phase 3N (§3, §55, §64)

- `grep -rEn "place_order|submit_order|placeOrder|cancel_order|modify_order|
  SmartConnect|kiteconnect|broker_api|live_broker"` over `ml-service/src/paper/**.py`
  → **zero matches** (the only occurrences of the word "broker" are docstrings that
  say "No broker" / "NEVER connects to a broker").
- Every Phase 3N paper entrypoint fails closed on live: `PaperOrder.__post_init__`,
  `PaperTradingEngine.__init__`, and `PaperSession.__init__` all call
  `decision.provenance.assert_not_live(mode)`, which raises `LiveExecutionForbidden`
  for `live`/`LIVE`/`production`/`PRODUCTION`. `PaperReadiness` has **no LIVE_READY
  member** — this phase structurally cannot emit a live-ready verdict.
- The Phase 3M choke points remain in force (pipeline entry `normalize_mode`,
  shadow order construction, shadow engine execute). Phase 3N adds a fourth
  (paper engine/session) — all reuse the same single guard.

**Verdict:** live order path reachable = **NO**; live execution = **DISABLED**.

## C. Signal API unification (§43)

- The canonical unification contract is `paper.signals.CanonicalSignal` (Task 4),
  into which every discovered signal family adapts. It is the ml-service-side
  single shape carrying `signal_id / family / instrument / timestamp / direction /
  strength / confidence / alpha_score / expected_return / probability /
  expected_value / timeframe / regime / source_model / source_strategy /
  evidence_level / status / evidence_group / provenance`.
- The existing Next.js signal endpoints under `src/app/api/in/*` (ai-signals,
  daily-picks, fno-*, gex, ml-predictions, nifty-bias, opportunity-engine,
  option-chain, …) already serve their consumers and are **not broken** by Phase 3N.
  Unification is delivered as an **adapter/contract at the boundary**, not a
  rewrite: the `CanonicalSignal` schema is the target shape an adapter maps those
  responses into, so existing consumers continue to work unchanged.
- No frontend files were modified in Phase 3N.

**Verdict:** unification available via contract + adapter; existing consumers
preserved.

## D. Auto-promotion / retraining / recalibration (§J)

Reconfirmed from Task 1: lifecycle promotion is human-gated
(`PromotionOrchestrator` requires `confirm_promotion` for HUMAN_APPROVAL_REQUIRED),
`monitoring.model_registry` emits retraining *recommendations* only (never auto),
and Phase 3N adds no scheduler and no auto path. All three remain **DISABLED**.

---

## Summary

| Check | Result |
|-------|--------|
| Broker secrets in frontend | **NO** |
| Live order path reachable (incl. from Phase 3N) | **NO** |
| Live execution enabled | **DISABLED** |
| Automatic promotion | **DISABLED** (human-gated) |
| Automatic retraining | **DISABLED** (recommendation only) |
| Automatic recalibration | **DISABLED** |
| Signal API unification | contract + adapter; consumers preserved |
| Frontend rewritten | **NO** |
