# Angel One SmartAPI Integration

This document is the authoritative reference for how **alpha-forge** uses Angel
One's **SmartAPI** to power the Indian-market (`/in/*`) surface — market data,
first-party derivatives, the real-time tick feed, and the read-only broker
account layer.

> **Design principle — graceful degradation.** Angel One is a _first-party
> accelerator_, never a hard dependency. Every SmartAPI code path degrades
> transparently to the existing **Yahoo Finance** / **NSE** sources when Angel
> One is unconfigured or an upstream call fails. A deployment with **zero**
> SmartAPI credentials behaves exactly as it did before this integration.

---

## Table of contents

1. [Configuration](#1-configuration)
2. [Architecture & module map](#2-architecture--module-map)
3. [Authentication & session](#3-authentication--session)
4. [Market data](#4-market-data)
5. [First-party derivatives](#5-first-party-derivatives)
6. [Consumers: scanners & AI signals](#6-consumers-scanners--ai-signals)
7. [SmartStream WebSocket 2.0 (live tick feed)](#7-smartstream-websocket-20-live-tick-feed)
8. [Read-only account layer (portfolio / margin)](#8-read-only-account-layer-portfolio--margin)
9. [Options UI](#9-options-ui)
10. [HTTP API routes](#10-http-api-routes)
11. [SmartAPI endpoint reference](#11-smartapi-endpoint-reference)
12. [Fallback chain](#12-fallback-chain)
13. [Testing](#13-testing)
14. [Status & roadmap](#14-status--roadmap)

---

## 1. Configuration

SmartAPI is configured from **either** environment variables (deployer-wide,
also used by the worker + unauthenticated paths) **or** per-user encrypted
credentials saved through the API-keys UI. Environment credentials win.

### Environment variables (`.env.example`)

| Variable | Required | Purpose |
| --- | --- | --- |
| `SMARTAPI_API_KEY` | ✅ | SmartAPI app "private key" (`X-PrivateKey` header) |
| `SMARTAPI_CLIENT_CODE` | ✅ | Angel One client / login code |
| `SMARTAPI_PIN` | ✅ | Login PIN |
| `SMARTAPI_TOTP_SECRET` | ✅ | Base32 TOTP secret (from 2FA setup) — used to derive the rolling OTP |
| `SMARTAPI_LOCAL_IP` | ⬜ | Defaults to `127.0.0.1` |
| `SMARTAPI_PUBLIC_IP` | ⬜ | Defaults to `127.0.0.1` |
| `SMARTAPI_MAC_ADDRESS` | ⬜ | Defaults to `00:00:00:00:00:00` |

When the four required vars are present, `isAngelConfigured()` returns `true`.

### Per-user credentials

Signed-in users can store an encrypted Angel One key set via the profile
API-keys form. Resolution order (`resolveConfig()`):

1. `readEnvCredentials()` → environment.
2. else dynamic `import("@/features/settings/angel-credentials")` →
   `getAngelConfigForRequest()` (decrypts the per-user record).
3. else `null` → callers fall back to Yahoo/NSE.

Relevant files: `src/features/settings/angel-credentials.ts`,
`src/features/settings/api-keys.ts`, `src/features/settings/active-sources.ts`.

To make Angel One the **active** broker for a user, it must be selected in their
data-source preferences (`getActiveSelections()`), which feeds
`pickBrokerChain()`.

---

## 2. Architecture & module map

The integration sits behind the broker-agnostic **`BrokerAdapter`** abstraction
(`src/services/india/broker/types.ts`), so the rest of the app never imports
Angel One directly for the four core market-data methods.

```
src/services/india/angelone/
├── index.ts          AngelOneAdapter — auth, HTTP, quotes, candles, option
│                     chain, derivatives + account methods, both feeds
├── derivatives.ts    Pure parsers: gainers/losers · PCR · OI-buildup · greeks
├── smartstream.ts    Pure WebSocket 2.0 binary protocol + SmartStreamClient
└── portfolio.ts      Pure parsers: funds/margin · holdings · positions

src/services/india/websocket/gateway.ts   SSE feed gateway (poll OR push source)
src/services/india/broker/{types,factory}.ts   Adapter interface + chain picker
src/services/india/resolve.ts             Multi-source quote resolver
src/services/india/cache/                 Redis-backed memo (in-memory fallback)
```

**Separation of concerns:** every SmartAPI module isolates a _pure_ parser layer
(no I/O, fully unit-tested) from the adapter's network/auth/cache plumbing. This
is why coverage is high despite the heavy reliance on a live broker API.

The singleton adapter instance is exported as `angel` from
`@/services/india/angelone`.

### `AngelOneAdapter` public surface

```ts
class AngelOneAdapter implements BrokerAdapter {
  readonly id = "angel";

  // BrokerAdapter (market data)
  getQuote(symbol): Promise<Quote>
  getQuotes(symbols, opts?): Promise<Quote[]>
  getHistorical(req, opts?): Promise<Candle[]>
  getOptionChain(symbol, expiry?): Promise<OptionChain>

  // First-party derivatives
  getTopGainersLosers(dataType, expiry?): Promise<DerivGainerLoser[]>
  getPutCallRatio(): Promise<DerivPcr[]>
  getOiBuildup(datatype, expiry?): Promise<DerivOiBuildup[]>

  // Read-only account data
  getFunds(): Promise<AccountFunds | null>
  getHoldings(): Promise<HoldingsResult | null>
  getPositions(): Promise<Position[] | null>

  // Live feed
  subscribeFeedWs(symbols, onTick, intervalMs?): Promise<() => void>  // WebSocket 2.0 → poll fallback
  subscribeFeed(symbols, onTick, intervalMs?): () => void              // 5s FULL-quote poll
}
```

---

## 3. Authentication & session

- **Login:** `POST /rest/auth/angelbroking/user/v1/loginByPassword` with
  `{ clientcode, password: pin, totp, state: "alphaforge" }`.
- **TOTP:** generated locally (RFC-6238, 30s / 6-digit / HMAC-SHA1) from the
  base32 secret via `generateTotp()` (`base32Decode` + Node `crypto`).
- **Session cache:** keyed per `clientCode` in an in-process `Map`, storing
  `{ jwt, feedToken, expiresAt }`. SmartAPI sessions die at **midnight IST**, so
  `expiresAt = midnightIstMs()` and tokens are reused until ~60s before expiry.
- **`feedToken`** is captured at login specifically for the SmartStream
  WebSocket handshake (see §7).

### HTTP helpers

| Helper | Method | Used by |
| --- | --- | --- |
| `smartApiPost<T>(cfg, path, body, jwt?)` | POST | login, quotes, candles, derivatives |
| `smartApiGet<T>(cfg, path, jwt)` | GET | account data (RMS / holdings / positions) |

Both attach the standard headers (`X-PrivateKey`, `X-UserType`, IP/MAC, and
`Authorization: Bearer <jwt>` when present), unwrap the SmartAPI envelope
(`{ status, message, errorcode, data }`), and throw a descriptive error when
`status` is false. `timedFetch` applies a 10s timeout.

---

## 4. Market data

### Quotes — FULL-mode enrichment

`getQuotes()` resolves each symbol to an Angel token (`resolveAngelToken` over a
cached ScripMaster equity map + hardcoded `INDEX_TOKENS`) and fetches the
**FULL** market-quote mode. `quoteFromQuoteRow()` maps the response onto the
canonical `Quote`, including the enrichment fields that the prior Yahoo/NSE path
lacked:

- `oi`, `weekHigh52`, `weekLow52`, `upperCircuit`, `lowerCircuit`
- `totalBuyQty`, `totalSellQty`
- **`orderBookImbalance` ∈ [-1, 1]** — derived buy-vs-sell pressure
  (`(buy − sell) / (buy + sell)`), the micro-flow signal the crypto surface had
  via liquidations but India previously lacked.

Unresolved symbols fall back to Yahoo; a fully-unconfigured adapter delegates
the whole call to `yahoo.getQuotes()`.

### Candles

`getHistorical()` maps app intervals → SmartAPI interval codes
(`intervalToSmartApi`) and the requested range → a `from` timestamp
(`rangeToFromMs`, `toSmartApiDateTime`), then normalises the OHLCV tuples via
`candlesFromCandleData()`.

### Option chain + full greeks

`getOptionChain()` synthesises a chain SmartAPI does not expose directly:

1. **ScripMaster** (cached 12h) → per-strike CE/PE tokens for the underlying +
   expiry.
2. **Quote API** (batched 50/req) → OI, LTP, traded volume per token.
3. **Option Greeks API** → `parseGreekRows()` returns **delta / gamma / theta /
   vega / IV** per strike (previously IV-only). These are plumbed through
   `OptionLeg` so `/api/in/option-chain` carries them.

#### Real per-leg `changeInOi`

SmartAPI quotes ship **no** ΔOI field, and per-token historical OI is
rate-limit-prohibitive. Instead the adapter maintains a **session-open OI
baseline** per `underlying:expiry`, cached until midnight IST. `computeOiChanges`
diffs live per-token OI against that baseline, so the chain, its aggregate
`total{Ce,Pe}OiChange`, and the per-strike ΔOI column report **genuine intraday
build-up / unwinding** (the Angel chain used to report `0` on every strike).

---

## 5. First-party derivatives

Pure parsers in `angelone/derivatives.ts` normalise three whole-F&O-segment
endpoints (`marketData/v1/*`) into typed shapes; the adapter wraps each with
caching + graceful fallback.

| Adapter method | Endpoint | Parser | Returns |
| --- | --- | --- | --- |
| `getTopGainersLosers(dataType, expiry)` | `gainersLosers` | `parseGainersLosers` | `DerivGainerLoser[]` |
| `getPutCallRatio()` | `putCallRatio` | `parsePcr` | `DerivPcr[]` |
| `getOiBuildup(datatype, expiry)` | `OIBuildup` | `parseOiBuildup` | `DerivOiBuildup[]` |

The OI-buildup parser maps SmartAPI's authoritative **Long Built Up · Short
Built Up · Short Covering · Long Unwinding** classification across the entire
F&O segment (stocks **and** indices) — far broader than the four indices the NSE
option chain covers.

---

## 6. Consumers: scanners & AI signals

The point of the derivatives work is that the app's _intelligence_ runs on
first-party data when Angel is configured, not just the raw quote backstop.

### Scanners (`src/services/india/scanner/engine.ts`)

`runMomentum`, `runPcr` and `runOiBuildup` each try their Angel-backed variant
first (`runMomentumAngel` / `runPcrAngel` / `runOiBuildupAngel`) and fall back to
the Yahoo/NSE implementation when Angel isn't configured or returns nothing. The
OI-Buildup scanner in particular now uses the whole-segment build-up lists rather
than the synthesised per-strike ΔOI.

### AI signals (`src/features/ai-signals/india-builder.ts`)

The India multi-confluence engine's `pcr` and `oiBuildup` factors prefer
SmartAPI's whole-segment PCR and OI build-up over the chain-derived values
(`loadFirstPartyDerivatives` → `pcrOverride` / `oiOverride`), with transparent
fallback. PCR rationale rows are tagged `(SmartAPI)` when first-party. Helper
maps `pcrMapFromRows` / `oiScoreMapFromRows` are pure and unit-tested.

---

## 7. SmartStream WebSocket 2.0 (live tick feed)

Replaces the 5s FULL-quote poll behind the SSE feed with Angel's binary tick
stream **when Angel One is the active broker**.

### Pure protocol layer (`angelone/smartstream.ts`)

- **`parseSmartTick(frame)`** decodes the little-endian binary frames for all
  three modes — **LTP** (51 B), **Quote** (123 B), **SnapQuote** (379 B) —
  converting prices paisa → ₹ and extracting LTP, volume, total buy/sell qty,
  OHLC/close, OI, circuit limits and the 52-week range. Returns `null` for
  undersized/control frames.
- **`buildSubscribeMessage(...)`** builds the subscribe/unsubscribe JSON,
  grouping tokens by exchange type and dropping empty buckets.
- **`changePctFromTick(ltp, close)`** derives % change locally (Quote frames
  ship the previous close).
- Constants: `SMART_MODE`, `SMART_EXCHANGE_TYPE`, `SMART_STREAM_URL`.

#### Binary frame layout (little-endian)

| Offset | Type | Field |
| --- | --- | --- |
| 0 | int8 | subscription mode (1 LTP · 2 Quote · 3 SnapQuote) |
| 1 | int8 | exchange type |
| 2–26 | char×25 | token (null-terminated ASCII) |
| 27–34 | int64 | sequence number |
| 35–42 | int64 | exchange timestamp (ms) |
| 43–50 | int64 | last traded price (paisa) — **LTP frame ends @51** |
| 51–58 | int64 | last traded quantity |
| 59–66 | int64 | average traded price (paisa) |
| 67–74 | int64 | volume traded today |
| 75–82 | float64 | total buy quantity |
| 83–90 | float64 | total sell quantity |
| 91–122 | int64×4 | open / high / low / close (paisa) — **Quote frame ends @123** |
| 131–138 | int64 | open interest |
| 347–378 | int64×4 | upper / lower circuit, 52-week high / low — **SnapQuote ends @379** |

### Socket client (`SmartStreamClient`)

Side-effect-free construction; `start()` opens a single `ws` socket with the
`Authorization` / `x-api-key` / `x-client-code` / `x-feed-token` handshake
headers, subscribes, runs a `ping` heartbeat (~25s) and reconnects with
exponential backoff. Frame handling lives in `handleMessage()` (delegates to the
pure parser), making it unit-testable without a live socket.

### Adapter + gateway wiring

- **`angel.subscribeFeedWs(symbols, onTick)`** resolves credentials + feed
  token, maps symbols → tokens, opens the socket and emits a `Quote` per frame
  (`quoteFromTick`). **Any** setup failure degrades to `subscribeFeed` (the 5s
  poll, itself Yahoo-backed), so it always returns a working unsubscribe handle.
- **`buildFeedStream`** (`websocket/gateway.ts`) gained an optional push
  `subscribe` source. When provided it replaces the poll loop (the poll still
  serves the one-shot initial snapshot); the interval is demoted to an SSE
  keep-alive heartbeat and the unsubscribe handle is invoked on cancel.
- **The SSE route** (`/api/in/feed/stream`) passes the WS source only when
  `chain[0].id === "angel"`; every other deployment keeps the exact prior poll
  behaviour.

---

## 8. Read-only account layer (portfolio / margin)

Pure parsers in `angelone/portfolio.ts` normalise SmartAPI's string-valued
account payloads (including the space-prefixed signed numbers it sometimes
returns, e.g. `"- 4471.60"`) into clean number-typed shapes.

| Adapter method | Endpoint (GET) | Parser | Returns |
| --- | --- | --- | --- |
| `getFunds()` | `user/v1/getRMS` | `parseFunds` | `AccountFunds \| null` |
| `getHoldings()` | `portfolio/v1/getAllHolding` | `parseHoldings` | `HoldingsResult \| null` |
| `getPositions()` | `order/v1/getPosition` | `parsePositions` | `Position[] \| null` |

- `parseFunds` → net, available cash, intraday payin, limit margin, collateral,
  realized/unrealized M2M, utilised debits.
- `parseHoldings` → handles both the newer `{holdings, totalholding}` shape and
  the legacy bare array; produces per-holding rows + a portfolio summary.
- `parsePositions` → net positions with normalised numeric fields.

Each method is short-TTL cached and returns `null` when Angel is unconfigured or
the call fails, so the UI can render a "connect Angel One" empty state.

> **No live order placement.** This layer is strictly read-only. `placeOrder` /
> `modifyOrder` / `cancelOrder` are intentionally **not** implemented — they move
> real money and are deferred behind a future explicit live-trading opt-in.

---

## 9. Options UI

The `/in/options` chain table (`src/components/india/options/option-chain-table.tsx`):

- A **Greeks** toggle reveals per-strike CE/PE **delta** columns (off by default).
- The **ΔOI** column renders the real intraday build-up (§4).

The **`UnderlyingFlow`** micro-strip
(`src/components/india/options/underlying-flow.tsx`) surfaces the FULL-mode
enrichment that rides `/api/in/quote`: **order-book imbalance** (center-origin
gauge), **52-week range** and **daily circuit limits**. It renders nothing when
no enrichment is present — so index underlyings (no order book) and non-Angel
deployments degrade cleanly. The page polls `/api/in/quote?symbols=<symbol>`
alongside the chain.

---

## 10. HTTP API routes

| Route | Backed by | Notes |
| --- | --- | --- |
| `GET /api/in/quote?symbols=…` | `resolveQuotes` (active chain) | FULL-quote enrichment when Angel serves it |
| `GET /api/in/option-chain?symbol=…&expiry=…` | `getOptionChain` | greeks + real ΔOI |
| `GET /api/in/feed/stream?symbols=…` | `buildFeedStream` | SSE; SmartStream WS when Angel is active |
| `GET /api/in/portfolio` | `getFunds`/`getHoldings`/`getPositions` | read-only; `{ connected, funds, holdings, positions }` |
| `GET /api/in/scanner` | scanner engine | Angel-backed momentum / PCR / OI-buildup |
| `GET /api/in/ai-signals` | India AI builder | first-party PCR / OI factors |

---

## 11. SmartAPI endpoint reference

| Capability | HTTP | Path |
| --- | --- | --- |
| Login | POST | `/rest/auth/angelbroking/user/v1/loginByPassword` |
| Market quote (FULL/OHLC/LTP) | POST | `/rest/secure/angelbroking/market/v1/quote/` |
| Historical candles | POST | `/rest/secure/angelbroking/historical/v1/getCandleData` |
| Option greeks | POST | `/rest/secure/angelbroking/marketData/v1/optionGreek` |
| Gainers / losers | POST | `/rest/secure/angelbroking/marketData/v1/gainersLosers` |
| Put-call ratio | POST | `/rest/secure/angelbroking/marketData/v1/putCallRatio` |
| OI build-up | POST | `/rest/secure/angelbroking/marketData/v1/OIBuildup` |
| Funds & margin (RMS) | GET | `/rest/secure/angelbroking/user/v1/getRMS` |
| Holdings | GET | `/rest/secure/angelbroking/portfolio/v1/getAllHolding` |
| Positions | GET | `/rest/secure/angelbroking/order/v1/getPosition` |
| Live tick stream | WSS | `wss://smartapisocket.angelone.in/smart-stream` |
| ScripMaster dump | GET | `margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json` |

Base REST host: `https://apiconnect.angelone.in`.

---

## 12. Fallback chain

```
Request
  │
  ├─ Angel One configured & selected?  ──no──►  Yahoo / NSE (unchanged default)
  │            │ yes
  │            ▼
  │   SmartAPI call (cached)
  │            │
  │            ├─ success ─►  first-party data (quotes / derivatives / feed / account)
  │            │
  │            └─ error / partial ─►  per-symbol Yahoo backfill  ·  poll feed  ·  null account
  │
  ▼
Canonical Quote / OptionChain / FeedDiff / portfolio payload
```

The cache (`src/services/india/cache`) is Redis-backed with an automatic
in-memory fallback, so memoisation works with or without Redis.

---

## 13. Testing

Pure parser/protocol layers are exhaustively unit-tested (no network):

| Test file | Covers |
| --- | --- |
| `tests/services/india-angelone.test.ts` | adapter helpers, quote/imbalance/ΔOI mapping |
| `tests/services/india-angelone-derivatives.test.ts` | gainers-losers / PCR / OI-buildup / greeks parsers |
| `tests/services/india-angelone-smartstream.test.ts` | binary frame parser, subscribe builder, client `handleMessage` |
| `tests/services/india-angelone-portfolio.test.ts` | funds / holdings / positions parsers |
| `tests/services/india-feed-gateway.test.ts` | SSE gateway snapshot + poll path |
| `tests/features/ai-signals-india-derivatives.test.ts` | AI signal first-party PCR/OI wiring |
| `tests/components/option-chain-table.test.tsx` | greeks toggle |
| `tests/components/option-underlying-flow.test.tsx` | order-book imbalance / 52W / circuit surfacing |

Run the India service slice with `npm run test:services`, or the whole suite with
`npm test`.

---

## 14. Status & roadmap

**Shipped**

- [x] First-party F&O scanners (momentum / PCR / OI-buildup) prefer SmartAPI.
- [x] AI signals read first-party PCR / OI build-up.
- [x] Full option greeks (delta / gamma / theta / vega) on the chain.
- [x] FULL-quote enrichment + derived order-book imbalance.
- [x] Real per-leg intraday `changeInOi` (session-open baseline diff).
- [x] Options UI — greeks toggle, real ΔOI, `UnderlyingFlow` micro-strip.
- [x] SmartStream WebSocket 2.0 binary tick feed with poll fallback.
- [x] Read-only account layer (funds / holdings / positions) + `/api/in/portfolio`.

**Remaining**

- [ ] **Account UI** — a "Broker account" panel beside Paper Trading
      (live funds / holdings / positions vs the simulated journal).
- [ ] **Live order placement** — `placeOrder` / `modifyOrder` / `cancelOrder` +
      order/trade book, gated behind an explicit live-trading opt-in (moves real
      money — deliberately deferred).

See the **Roadmap** section of [`README.md`](./README.md) for the cross-cutting
project roadmap.
