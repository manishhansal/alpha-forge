# Phase 4B — Provider Setup (Real-Market Data)

**Repository:** alpha-forge · **Branch:** `refactor/improve-ml-service`
**Purpose:** Document what must be configured to activate real Indian-market data for frozen paper-evidence collection.
**This document contains NO secret values.** It lists variable *names*, their consumer, scope, and how to verify them safely.

> Security rule (§3): provider credentials live ONLY in secure backend/runtime configuration. They must NEVER appear in React/Next.js client code, `NEXT_PUBLIC_*` variables, source files, git, reports, logs, evidence artifacts, or browser storage. The frontend must call the backend/data-service abstraction for market data — it never receives broker secrets.

---

## Provider hierarchy (frozen — do not change)

```
DATA_SERVICE (0)  →  ANGEL_ONE (1)  →  UPSTOX (2)  →  YAHOO (3)
```

Selector: `INDIA_DATA_PROVIDER=auto` (default). NSE direct acquisition is **not supported** and must not be added. When a provider is unconfigured or fails, the failover engine routes to the next provider in priority order.

## Required / optional environment variables

All variables are **server-side only**. No `NEXT_PUBLIC_` variant may ever be created for any credential.

### Angel One SmartAPI — PRIMARY (provider 1)

| Variable | Consumer | Scope | Required for Angel? |
| --- | --- | --- | --- |
| `SMARTAPI_API_KEY` | Data service / market-data layer | Confidential | Yes |
| `SMARTAPI_CLIENT_CODE` | Angel auth | Confidential (client/trading ID) | Yes |
| `SMARTAPI_PIN` | Angel auth | Confidential (4-digit MPIN, not web password) | Yes |
| `SMARTAPI_TOTP_SECRET` | Angel auth (2FA) | Confidential (base32 from QR) | Yes |
| `SMARTAPI_PUBLIC_IP` | Angel/NSE WAF headers | Operational | Optional (needed if 403) |
| `SMARTAPI_LOCAL_IP` / `SMARTAPI_MAC_ADDRESS` / `SMARTAPI_USER_AGENT` | Angel WAF headers | Operational | Optional |

Note: Angel's Akamai gateway and the NSE charting API used by the data service return HTTP 403 for requests from suspicious/non-India source IPs. If persistent 403s occur, set `SMARTAPI_PUBLIC_IP` to a real Indian residential egress IP.

### Upstox — SECONDARY (provider 2)

| Variable | Consumer | Scope | Required for Upstox? |
| --- | --- | --- | --- |
| `UPSTOX_ANALYTICS_TOKEN` | Upstox data path (preferred) | Confidential (long-lived read-only bearer) | One of these paths |
| `UPSTOX_CLIENT_ID` | Upstox OAuth2 | Server-side | OAuth path |
| `UPSTOX_CLIENT_SECRET` | Upstox OAuth2 token exchange | Confidential | OAuth path |
| `UPSTOX_REDIRECT_URI` | Upstox OAuth2 callback | Config | OAuth path |
| `UPSTOX_ACCESS_TOKEN` | Legacy direct token | Confidential | Legacy (prefer analytics token) |

Preferred: set `UPSTOX_ANALYTICS_TOKEN` (avoids OAuth round-trips). When none are set, Upstox is silently unconfigured and failover routes `DATA_SERVICE → ANGEL_ONE → YAHOO`.

### Yahoo Finance — FALLBACK (provider 3)

No credentials required.

### Data Service / Scrapling — PROVIDER 0

Configured via the data-service deployment (see data-service docs). No broker secrets belong in the ML service.

### Live-trading safety flag (must stay disabled)

| Variable | Required state for Phase 4B |
| --- | --- |
| `LIVE_TRADING_ENABLED` | unset or `false` — Phase 4B is PAPER-ONLY. Never set to `true`. |

## Where to configure

Backend/runtime environment only (e.g. `.env.docker` / container secrets / secret manager) — never `.env.example` (template), never committed, never frontend. `.env.example` documents names with empty values as a template.

## Health-check procedure (before first session)

1. Start the data-service + ML-service with credentials supplied via secure runtime env (not git).
2. For each provider independently verify (§5): authentication status, connectivity, actual returned OHLCV validity (not just auth success), symbol availability, F&O availability where applicable, latency, timestamp validity.
3. Confirm the failover order resolves `DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO`.
4. Confirm `LIVE_TRADING_ENABLED` is unset/false.
5. Confirm no credential appears in any log/report/response (§3, §42).

## Verifying a credential WITHOUT exposing it

- Check *presence* only: e.g. `test -n "$SMARTAPI_API_KEY" && echo SET || echo UNSET` (never print the value).
- Verify via a provider health endpoint that returns a boolean auth/connectivity status, not the token.
- Never echo, log, or write credential values into reports or evidence.

## Credential rotation

- Rotate on the provider's console (Angel SmartAPI / Upstox Developer Console).
- Update the backend runtime secret store only; never commit.
- A credential change does not alter the frozen ML system, but the provider-configuration hash in the evidence-window manifest changes — record it as a new provider-config version so evidence lineage stays accurate.

## Do NOT

- Automate broker login / OTP / CAPTCHA / token scraping / browser automation (§41). Use the provider's supported auth mechanism with securely supplied credentials/tokens.
- Add a new provider or change provider priority.
- Place any secret in the frontend or in git.
