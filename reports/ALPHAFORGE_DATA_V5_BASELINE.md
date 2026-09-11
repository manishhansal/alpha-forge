# ALPHAFORGE — DATA FOUNDATION V5 BASELINE

- **queriedAt:** 2026-09-11 (~16:45→17:xx IST, NSE session closed; historical + option APIs work regardless).
- **database:** `crypto_dashboard` @ localhost:5433 (docker, healthy). Redis, data-service, ml-service healthy.
- **git HEAD at start:** `bc1e0da` (V4 commit) on `refactor/signals`.

## Starting state (before V5 fix — matched V4)
- CandleBar 89,810 (all `1d`, provider NULL). **Intraday = 0** (1m/3m/5m/10m/15m/30m/1h all zero) — the primary problem.
- `.env` broker vars empty; V4 concluded Angel/Upstox `configured:false`.
- durable: dataGap 245, incident 2, providerObservation 1 (post-V4 purge), correction 0, optionChainSnapshot ~2,941 (aggregate only), optionChainStrike table did not exist.

## The V5 finding
Broker credentials WERE configured — in the DB (`UserSetting.apiKeysEncrypted`),
via the frontend, not `.env`. The worker used session-based resolvers that
returned null without a session → silent Yahoo fallback → intraday 0. See
`ALPHAFORGE_DATA_V5_CREDENTIAL_FLOW.md`.

## V5 objective
Fix the credential propagation, authenticate for real, and get REAL intraday +
F&O data into Postgres — no fabrication, no ML/signal changes.
