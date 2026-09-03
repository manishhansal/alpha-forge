# Design Document: scrapling-data-service

## Overview

AlphaForge's existing market data pipeline requires broker credentials at Priority 1 (Angel One SmartAPI) and carries a fragile NSE scraper at Priority 3. A TOTP expiry or Akamai shadow-ban silently degrades the most critical paths.

This feature introduces a credential-free data tier. A dedicated Python microservice (`data-service`) runs [Scrapling](https://github.com/D4Vinci/Scrapling) (BSD-3-Clause) to intercept NSE and BSE's own JSON API payloads using full TLS fingerprint spoofing and headless Chromium automation. A companion TypeScript `ScraplingProvider` registers at Priority 0 in the existing `ProviderRegistry`, demoting Angel One to first fallback. The existing `withFailover` chain (Angel One → Upstox → NSE → Yahoo) becomes the graceful degradation path and requires no changes.

**Key design goals:**
- Zero credential dependency for the primary data path
- No changes to existing provider interfaces or failover logic
- Isolated microservice (Docker, port 8200) that other services call over HTTP and Redis pub/sub
- Comprehensive correctness guarantees on the pure-function analytics layer (PCR, max pain, ATM IV, timestamp conversion)

---

## Architecture

### System Context

```
┌────────────────────────────────────────────────────────────────────┐
│  data-service  (Python 3.11 · FastAPI · port 8200)                 │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │OptionChain   │  │ LiveQuote    │  │ BhavcopyScraper           │ │
│  │Scraper       │  │ Scraper      │  │ (FetcherSession)          │ │
│  │(capture_xhr) │  │(capture_xhr) │  │ NSE + BSE daily/intraday  │ │
│  └──────┬───────┘  └─────┬────────┘  └────────────┬──────────────┘ │
│         │                │                         │                │
│  ┌──────▼────────────────▼─────────────────────────▼─────────────┐ │
│  │ AntibanLayer: TokenBucket · BanDetector · ProxyManager        │ │
│  │                 · SessionWarmer                                │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  FastAPI REST  ·  TickPublisher (asyncio, 5s poll → Redis) │    │
│  │  GET /scraping/quotes          PUBLISH af:ticks:{SYMBOL}   │    │
│  │  GET /scraping/option-chain    GET /scraping/instruments    │    │
│  │  GET /scraping/historical      GET /monitoring/*            │    │
│  │  POST /publisher/symbols       GET /publisher/status        │    │
│  └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼──────────────────────┐
          │ REST (HTTP)        │ Redis PUBLISH         │
          ▼                    ▼                       │
┌─────────────────┐  ┌──────────────────┐             │
│ ScraplingProvider│  │  Redis (6379)    │             │
│ (Priority 0)    │  │  af:ticks:*      │             │
│ TypeScript      │  └────────┬─────────┘             │
│ ProviderRegistry│           │ PSUBSCRIBE             │
└────────┬─────────┘          ▼                       │
         │              ┌───────────────────┐          │
         │              │ Worker            │          │
         │              │ scraping-tick-    │          │
         │              │ listener.ts       │          │
         │              │ LiveFeedService   │          │
         │              └───────────────────┘          │
         │                                             │
         ▼  withFailover() — no changes required
  Angel One (1) → Upstox (2) → NSE (3) → Yahoo (4)
```

### Provider Priority After This Feature

| Priority | Provider | Credentials | Notes |
|---|---|---|---|
| **0** | **Scrapling** | **None** | Primary — always tried first |
| 1 | Angel One SmartAPI | Yes (4 env vars + TOTP) | First fallback |
| 2 | Upstox Analytics v2 | Yes (bearer token) | Second fallback |
| 3 | NSE direct scraper | No | Third fallback |
| 4 | Yahoo Finance | No | Historical only |

### Service Startup / Lifespan Order

The FastAPI `lifespan` context manages component startup and degraded-mode handling:

```
1. Load Settings (env vars, log resolved values)
2. Connect Redis (aioredis) — if fails, mark redis_available=False
3. Warm DynamicSession (headless Chromium) — if fails, degraded=True
4. Start AntibanLayer (rate limiters, ban detector, session warmer task)
5. Start TickPublisher asyncio task
6. Register all FastAPI routers
7. POST /health returns {"status": "degraded", "components": {...}} if any step 2-5 failed
   POST /health returns {"status": "healthy"} otherwise
```

Startup order ensures Docker's `healthcheck` always gets a response within 90 seconds even if Chromium warm-up is slow. Failed components are reported by name rather than causing a crash.

---

## Components and Interfaces

### 1. Python `data-service` Module Layout

```
data-service/
├── Dockerfile
├── requirements.txt
└── src/
    ├── server.py            # FastAPI app, lifespan, CORS middleware
    ├── config.py            # Settings dataclass (frozen, from env vars)
    ├── schemas.py           # Pydantic models: MDQuote, OHLCVCandle,
    │                        #   OptionChain, LiveTick, Instrument, HealthStatus
    ├── scrapers/
    │   ├── historical.py    # BhavcopyScraper — NSE + BSE OHLCV
    │   ├── live_quotes.py   # LiveQuoteScraper — capture_xhr
    │   ├── option_chain.py  # OptionChainScraper — capture_xhr + analytics
    │   └── instrument_master.py  # NSE lot sizes + BSE scrip master
    ├── publisher/
    │   ├── tick_publisher.py  # TickPublisher asyncio loop
    │   └── router.py          # GET /publisher/status, POST /publisher/symbols
    ├── anti_ban/
    │   ├── proxy_manager.py   # ProxyRotator wrapper
    │   ├── rate_limiter.py    # TokenBucketRateLimiter (per-domain)
    │   ├── ban_detector.py    # BanDetector — 3 detection patterns
    │   └── session_warmer.py  # Background asyncio pre-warm task
    └── monitoring/
        └── router.py          # GET /monitoring/health, /scraping-stats,
                               #   /proxy-status, /session-status
```

### 2. Scrapling Session Strategy

Two Scrapling session types are used, each with a distinct role:

**DynamicSession (headless Chromium)** — used for `capture_xhr` endpoints. One singleton instance is shared across all concurrent requests for the same scraper type. The session is kept alive in a `with DynamicSession(...) as session:` context that spans the entire service lifetime.

```python
# One singleton per scraper type — created at lifespan startup
_quote_session: AsyncDynamicSession | None = None
_chain_session: AsyncDynamicSession | None = None

async def get_quote_session() -> AsyncDynamicSession:
    global _quote_session
    if _quote_session is None:
        _quote_session = AsyncDynamicSession(
            headless=True,
            network_idle=True,
            proxy=settings.scrapling_proxy_url,
        )
    return _quote_session
```

The `capture_xhr` call pattern intercepts XHR responses the page makes naturally:

```python
page = await session.fetch(
    "https://www.nseindia.com/option-chain",
    capture_xhr="api/option-chain",  # substring match on XHR URL
    network_idle=True,
)
# page.captured_xhr: list[Response] — all XHR responses whose URL contains the pattern
chain_data = next(
    (r.json() for r in page.captured_xhr if "option-chain" in r.url),
    None,
)
```

Adaptive tracking is activated on first successful scrape to survive NSE page redesigns:

```python
# First scrape — save structural fingerprint
page.css('[data-expiry]', auto_save=True)

# Subsequent scrapes — relocate automatically if page structure changes
page.css('[data-expiry]', adaptive=True)
```

**FetcherSession (HTTP-only, TLS fingerprint spoofing)** — used for archive endpoints that serve unauthenticated static files (Bhavcopy, instrument master CSV). No browser needed:

```python
with FetcherSession(impersonate='chrome', stealthy_headers=True) as session:
    response = session.get(
        "https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv"
    )
    csv_text = response.text
```

**Fallback chain:** if `DynamicSession` raises `BrowserError` or times out (15s for option chain, 10s for quotes), the scraper falls back to `FetcherSession` with `impersonate='chrome'` for a direct HTTP attempt.

### 3. BhavcopyScraper

Handles all historical OHLCV requests. Two sub-paths based on interval:

**Daily (`1d`) — NSE Bhavcopy:**
```
GET https://www.nseindia.com/api/historicalOR
    ?series=EQ&symbol={SYMBOL}&from={DD-MM-YYYY}&to={DD-MM-YYYY}&csvFlag=1
```
Response: CSV with columns `Date, OPEN, HIGH, LOW, CLOSE, TOTTRDQTY`. `Date` format: `DD-MMM-YYYY`.

**Daily (`1d`) — BSE Bhavcopy:**
```
GET https://www.bseindia.com/download/BhavCopy/Equity/EQ{DDMMYYYY}_CSV.ZIP
```
Response: ZIP containing `EQ{DDMMYYYY}_CSV.CSV` with columns `Code, Open, High, Low, Close, No of Shares`.

**Intraday (`5m`, `15m`, `30m`, `1h`) — NSE charting API:**
```
GET https://charting.nseindia.com/charts/getData
    ?appid=chartiq&symbol={SYMBOL}&period={5|15|30|60}&type=EQ
    &startDate={DD-MM-YYYY}&endDate={DD-MM-YYYY}
```
Response: `{"grapthData": [[timestamp_ms_ist, open, high, low, close, volume], ...]}`

**Intraday — BSE:**
```
GET https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w
    ?scripcode={BSE_CODE}&Resolution={5|15|30|60}&Category=EQ
    &FromDate={DD/MM/YYYY}&ToDate={DD/MM/YYYY}
```
Response: `{"Data": [[timestamp_ms_ist, open, high, low, close, volume], ...]}`

**IST → UTC timestamp conversion** (applied to all intraday sources):
```python
utc_epoch_s = (timestamp_ms_ist / 1000) - 19800
# 19800 = 5.5 hours × 3600 seconds/hour (IST offset)
```

### 4. LiveQuoteScraper

Maintains a singleton `AsyncDynamicSession`. Two fetch modes:

**Batch (symbols that are NIFTY 200 constituents):**
- Load `https://www.nseindia.com/market-data/live-equity-market`
- Intercept XHR matching `equity-stockIndices?index=NIFTY%20200`
- Returns all 200 constituents; filter to requested symbols

**Single / non-constituent symbols:**
- For each symbol not in NIFTY 200 (or for individual requests): intercept `api/quote/equity?symbol={SYMBOL}`

**Mixed batches:** constituent symbols fetched via batch endpoint; non-constituent symbols fetched individually; results merged in original input order.

**Cache write after every fetch:**
```
Key: scraping:quote:{exchange}:{symbol}
Value: serialized MDQuote JSON
TTL: 5 seconds
```

### 5. OptionChainScraper

Uses `DynamicSession` as primary, `FetcherSession` as fallback.

**NSE path:**
```python
page = await session.fetch(
    "https://www.nseindia.com/option-chain",
    capture_xhr="api/option-chain",
    network_idle=True,
)
# Payload structure:
# {
#   "records": {
#     "data": [{...CE/PE contracts...}],
#     "expiryDates": ["24-JUL-2025", ...],
#     "underlyingValue": 24850.60
#   }
# }
```

**BSE SENSEX path:**
```python
page = await session.fetch(
    "https://www.bseindia.com/markets/Derivatives/DerivativeHome.aspx?flag=03",
    capture_xhr="GetOptionChain",
    network_idle=True,
)
```

**Analytics computation** (pure functions, fully testable):

```python
def compute_pcr_oi(rows: list[OptionChainRow]) -> float | None:
    total_ce = sum(r.ce.oi for r in rows if r.ce)
    total_pe = sum(r.pe.oi for r in rows if r.pe)
    return round(total_pe / total_ce, 2) if total_ce > 0 else None

def compute_max_pain(rows: list[OptionChainRow]) -> float | None:
    strikes = [r.strike for r in rows]
    def pain_at(s: float) -> float:
        return sum(
            max(0, s - r.strike) * (r.ce.oi if r.ce else 0) +
            max(0, r.strike - s) * (r.pe.oi if r.pe else 0)
            for r in rows
        )
    if not strikes:
        return None
    min_pain = min(pain_at(s) for s in strikes)
    candidates = [s for s in strikes if pain_at(s) == min_pain]
    # Tie-break: highest CE OI
    def ce_oi(s: float) -> int:
        row = next((r for r in rows if r.strike == s), None)
        return row.ce.oi if row and row.ce else 0
    return max(candidates, key=ce_oi)

def compute_atm_iv(rows: list[OptionChainRow], spot: float) -> float | None:
    # 5 strikes nearest to spot by absolute distance
    sorted_rows = sorted(rows, key=lambda r: abs(r.strike - spot))
    ivs = []
    for row in sorted_rows[:5]:
        if row.ce and row.ce.greeks.iv and row.ce.oi > 0:
            ivs.append(row.ce.greeks.iv)
        if row.pe and row.pe.greeks.iv and row.pe.oi > 0:
            ivs.append(row.pe.greeks.iv)
    return round(sum(ivs) / len(ivs), 2) if len(ivs) >= 2 else None
```

**Cache:**
```
Key: scraping:chain:{underlying}:{expiry}:{exchange}
TTL: 20 seconds
```

**Warm-up endpoint:** `POST /scraping/option-chain/warm` loads the NSE option chain page synchronously, discards the result, and returns `{"warmed": true, "session_ready": true}` only after a successful XHR capture is confirmed.

### 6. AntibanLayer

#### TokenBucketRateLimiter

One instance per domain. Implemented as an asyncio token bucket with a FIFO overflow queue.

```python
class TokenBucketRateLimiter:
    def __init__(self, domain: str, rate: float, capacity: float):
        self._domain = domain
        self._rate = rate          # tokens per second
        self._capacity = capacity  # bucket max
        self._tokens = capacity
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._last_refill = asyncio.get_event_loop().time()

    async def acquire(self) -> None:
        """Block until a token is available. Raises QueueFullError at depth 1000."""
        now = asyncio.get_event_loop().time()
        elapsed = now - self._last_refill
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
        self._last_refill = now
        if self._tokens >= 1:
            self._tokens -= 1
            return
        # Queue for later service
        if self._queue.full():
            raise QueueFullError(f"{self._domain} rate limit queue full (1000 requests)")
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        await self._queue.put(fut)
        await fut   # FIFO — resolved when the token becomes available
```

Domain limits (configurable via env vars):
- `nseindia.com`: 3 req/s (`NSE_RATE_LIMIT`, min 1, max 20)
- `bseindia.com`: 2 req/s (`BSE_RATE_LIMIT`, min 1, max 20)
- `nsearchives.nseindia.com`: unlimited (CloudFront CDN, no anti-bot)

#### BanDetector

Three detection patterns, checked in order:

```python
class BanPattern(Protocol):
    def matches(self, body: str | dict) -> bool: ...

class ShadowBanPattern:
    """NSE returns 200 OK but empty records during a shadow-ban."""
    def matches(self, body) -> bool:
        if not isinstance(body, dict):
            return False
        data = body.get("records", {}).get("data")
        return data == [] and _is_market_hours_ist()

class AkamaiChallengePattern:
    """Akamai challenge page contains JavaScript bot-check identifier."""
    def matches(self, body) -> bool:
        return isinstance(body, str) and "window._atsb" in body

class RateLimitPattern:
    """Upstream rate-limit response."""
    def matches(self, body) -> bool:
        return isinstance(body, str) and "Too Many Requests" in body
```

#### Ban Response Cycle

```
Detect ban
  → Rotate to next proxy (ProxyManager.rotate())
  → Reset DynamicSession (close and recreate)
  → Increment ban_counter (for /monitoring/health)
  → await asyncio.sleep(BAN_BACKOFF_SECONDS)  # default 60s
  → Retry original request
  → If ban detected again: repeat cycle, max 5 consecutive attempts
  → After 5 failures: propagate BanError to caller
```

#### SessionWarmer

Background asyncio task. Runs only during IST market hours (03:30–10:30 UTC):

```python
MARKET_OPEN_UTC_HOUR, MARKET_OPEN_UTC_MIN = 3, 30
MARKET_CLOSE_UTC_HOUR, MARKET_CLOSE_UTC_MIN = 10, 30
WARM_INTERVAL_SECONDS = 30 * 60  # 30 minutes

async def _warm_loop(self):
    while self._running:
        now_utc = datetime.now(UTC)
        if _is_in_market_window(now_utc):
            await self._warm_session()
            self._last_warm_at = now_utc
        await asyncio.sleep(WARM_INTERVAL_SECONDS)
```

### 7. TickPublisher

An asyncio background task started during lifespan. Polls `LiveQuoteScraper` every 5 seconds and publishes to Redis pub/sub.

**Publication format:**
```
Channel: af:ticks:{SYMBOL}   (uppercase)
Payload: JSON-encoded LiveTick object
```

**Null ltp skip rule:** if a quote's `ltp` is `null` or absent, the symbol is skipped for that polling cycle; `publish_count` is not incremented.

**Reconnection:** exponential backoff on Redis connection loss — starting at 1s, doubling each attempt, capped at 30s. The `GET /publisher/status` endpoint returns `"running": "reconnecting"` during outage.

**Dynamic symbol management:** `POST /publisher/symbols` with `{"add": [...], "remove": [...]}` applies both operations atomically to the in-memory symbol set. No service restart required.

### 8. TypeScript ScraplingProvider

Implements `MarketDataProvider` from `src/lib/market-data/provider.ts`. Registered at `priority: 0` in `bootstrapRegistry()`.

**Design decisions:**
- `enabled: !!process.env.DATA_SERVICE_URL` — opt-in via env var; when unset, every method returns the empty/null sentinel value instead of throwing, so `withFailover` proceeds to Angel One cleanly
- `getOptionChain` is the one exception: throws `MarketDataError(code: "NOT_CONFIGURED")` when unset, because `withFailover` needs a thrown error to move to the next provider
- A shared `dsGet<T>()` helper handles all HTTP calls with abort signal forwarding and throws `MarketDataError` on 4xx/5xx, triggering the existing retry/failover logic in `withRetry` and `withFailover`
- The `subscribe()` method provides a polling fallback (5s interval) for code paths that don't use the Redis tick pipeline; the primary tick delivery path is `scraping-tick-listener.ts`

**`ProviderId` extension** (`src/lib/market-data/types.ts`):
```typescript
// "scrapling" added as first entry so PROVIDER_PRIORITY lists it first
export type ProviderId = "scrapling" | "angel_one" | "upstox" | "nse" | "yahoo";

export const PROVIDER_PRIORITY: readonly ProviderId[] = [
  "scrapling",
  "angel_one",
  "upstox",
  "nse",
  "yahoo",
];
```

**`getAllProviderHealth()` in `health.ts`** must be updated to include `"scrapling"` in its `allIds` array so health snapshots include the new provider.

### 9. Worker Tick Listener

File: `worker/src/jobs/scraping-tick-listener.ts`

Uses a **dedicated ioredis subscriber connection** (separate from the worker's command connection) to avoid blocking the worker's normal Redis operations. ioredis requires a dedicated connection when in subscriber mode.

**Activation gate:**
```typescript
// worker/src/config.ts
scrapingTicks: {
  enabled: Boolean(
    process.env.DATA_SERVICE_URL ||
    process.env.SCRAPING_TICK_LISTEN === "true"
  ),
},
```

When `enabled` is false, the listener never starts and the worker behaves identically to its current state.

**Error handling:** if the subscriber connection emits an unrecoverable error, the listener logs the failure and sets its internal state to stopped. `stopScrapingTickListener()` is safe to call in any state.

**`worker/src/redis.ts` addition:**
```typescript
export function createSubscriberClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL not set");
  // maxRetriesPerRequest: null is required for subscriber mode in ioredis
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
  });
}
```

### 10. ML MarketDataClient Upgrade

`ml-service/src/training/market_data_client.py` — the `get_ohlcv()` method gains a Tier 0:

```python
# Tier 0: data-service Scrapling (exchange-official Bhavcopy)
if DATA_SERVICE_URL:
    df = await _fetch_via_scrapling(symbol, interval, start_date, end_date)
    if df is not None and not df.empty:
        source_used = "scrapling_bhavcopy"
        df["_quality"] = DataQuality.GOOD
        # proceed to return
```

On HTTP 503/500 or connection error (10s timeout): log warning, proceed to Tier 1.
On HTTP 200 with empty candles array: proceed to Tier 1 silently (no warning).
When `DATA_SERVICE_URL` is unset: skip Tier 0 entirely, begin at Tier 1.

### 11. DataSourceBadge (React)

File: `src/components/india/DataSourceBadge.tsx`

Pill-shaped UI element. Polls `/api/in/provider-health` every 30 seconds after the previous response is received. Renders nothing until a valid provider name is received or when the provider is unknown.

**Color mapping:**
```typescript
const PROVIDER_COLORS: Record<ProviderId, string> = {
  scrapling:  "var(--color-data-positive)",
  angel_one:  "var(--color-data-positive)",
  upstox:     "var(--color-data-neutral)",
  nse:        "var(--color-data-neutral)",
  yahoo:      "var(--color-data-negative)",
};
```

**Display format:** `"Scrapling ● 180ms"` (title-case name, non-negative integer latency)

**`/api/in/provider-health` route** (`src/app/api/in/provider-health/route.ts`):
- Aggregates `registry.getHealth()` (all 5 providers) plus `data-service GET /monitoring/health`
- If `data-service` is unreachable: returns `{ scrapling: { available: false, latency_ms: 0 } }` — never returns 4xx/5xx

### 12. Monitoring Endpoints

All four monitoring endpoints are served from `data-service/src/monitoring/router.py`. Stats are in-memory only — reset to zero on service restart. No persistence.

**RollingWindowStats** — maintains a sliding window of the last 3600 seconds of request records. For each record: `(endpoint, duration_ms, success)`. P50/P99 computed on demand by sorting the window's duration values.

```python
@dataclass
class RequestRecord:
    endpoint: str
    duration_ms: int
    success: bool
    recorded_at: float  # monotonic time

class RollingWindowStats:
    WINDOW_SECONDS = 3600

    def record(self, endpoint: str, duration_ms: int, success: bool) -> None:
        now = time.monotonic()
        self._records.append(RequestRecord(endpoint, duration_ms, success, now))
        self._evict(now)

    def get_stats(self, endpoint: str) -> EndpointStats | None:
        now = time.monotonic()
        self._evict(now)
        records = [r for r in self._records if r.endpoint == endpoint]
        if not records:
            return None
        durations = sorted(r.duration_ms for r in records)
        success_count = sum(1 for r in records if r.success)
        n = len(durations)
        return EndpointStats(
            p50_ms=durations[int(0.50 * n)],
            p99_ms=durations[int(0.99 * n)],
            success_rate=round(success_count / n, 4),
        )
```

---

## Data Models

### Python Pydantic Schemas (`data-service/src/schemas.py`)

```python
from pydantic import BaseModel, Field
from typing import Optional

class OHLCVCandle(BaseModel):
    """UTC epoch seconds timestamp. All prices in INR (rupees), never paisa."""
    time: int               # UTC epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: int
    oi: Optional[int] = None

class Greeks(BaseModel):
    iv: Optional[float] = None
    delta: Optional[float] = None
    gamma: Optional[float] = None
    theta: Optional[float] = None
    vega: Optional[float] = None
    rho: Optional[float] = None

class OptionContract(BaseModel):
    token: str
    tradingSymbol: str
    underlying: str
    expiry: str             # ISO-8601 date (UTC)
    strike: float
    optionType: str         # "CE" | "PE"
    ltp: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    oi: int
    oiChange: int
    volume: int
    greeks: Greeks
    fetchedAt: str          # UTC ISO-8601

class OptionChainRow(BaseModel):
    strike: float
    ce: Optional[OptionContract] = None
    pe: Optional[OptionContract] = None

class OptionChainAnalytics(BaseModel):
    pcrOi: Optional[float] = None
    pcrVolume: Optional[float] = None
    maxCeOiStrike: Optional[float] = None
    maxPeOiStrike: Optional[float] = None
    totalCeOi: int
    totalPeOi: int
    totalCeOiChange: int
    totalPeOiChange: int
    atmIv: Optional[float] = None
    maxPain: Optional[float] = None

class OptionChain(BaseModel):
    """Field names and nesting are identical to the TypeScript OptionChain type."""
    underlying: str
    spot: Optional[float] = None
    expiry: str
    expiries: list[str]
    rows: list[OptionChainRow]
    analytics: OptionChainAnalytics
    provider: str           # fixed: "scrapling"
    fetchedAt: str          # UTC ISO-8601

class MDQuote(BaseModel):
    symbol: str
    token: Optional[str] = None
    exchange: Optional[str] = None
    name: Optional[str] = None
    ltp: Optional[float] = None
    change: Optional[float] = None
    changePct: Optional[float] = None
    prevClose: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[int] = None
    oi: Optional[int] = None
    upperCircuit: Optional[float] = None
    lowerCircuit: Optional[float] = None
    weekHigh52: Optional[float] = None
    weekLow52: Optional[float] = None
    totalBuyQty: Optional[int] = None
    totalSellQty: Optional[int] = None
    lastTradeTime: Optional[str] = None
    provider: str           # fixed: "scrapling"
    fetchedAt: str          # UTC ISO-8601

class LiveTick(BaseModel):
    token: str
    symbol: str
    exchange: str
    ltp: float
    change: Optional[float] = None
    changePct: Optional[float] = None
    volume: Optional[int] = None
    oi: Optional[int] = None
    exchangeTimestampMs: int    # UTC epoch milliseconds
    receivedAtMs: int           # UTC epoch milliseconds
    provider: str               # fixed: "scrapling"

class Instrument(BaseModel):
    token: str
    tradingSymbol: str          # max 50 chars
    name: str                   # max 100 chars
    exchange: str               # NSE | BSE | NFO | BFO
    lotSize: int                # positive; 0 when unknown
    instrumentType: str         # EQ | FUT | CE | PE
    expiry: str                 # YYYY-MM-DD or empty string for equities
    strike: float               # 0 for non-options
    optionType: str             # CE | PE | empty string for non-options
    isin: Optional[str] = None

class HealthStatus(BaseModel):
    status: str                 # "healthy" | "degraded"
    service: str                # "data-service"
    version: str                # semver
    timestamp: str              # UTC ISO-8601
    components: Optional[dict[str, str]] = None  # component_name → failure_reason
```

### Type Compatibility Guarantee

The Python `OptionChain` schema above uses identical field names and nesting depth to the TypeScript `OptionChain` type in `src/lib/market-data/types.ts`. `ScraplingProvider.getOptionChain()` returns the JSON response directly without any transformation. This is enforced by:
1. The Python schema is defined by reading the TypeScript type definition as the source of truth
2. A contract test in `data-service/tests/test_option_chain_schema_compat.py` asserts all TypeScript `OptionChain` fields are present in the Python schema

### Docker and Infrastructure

**`docker-compose.yml` additions:**

```yaml
  data-service:
    build:
      context: ./data-service
      dockerfile: Dockerfile
    container_name: alpha-forge-data
    restart: unless-stopped
    environment:
      DATA_SERVICE_PORT: "8200"
      REDIS_URL: "redis://redis:6379/0"
      DATA_DIR: "/app/data"
      SCRAPLING_HEADLESS: "true"
      NSE_RATE_LIMIT: "3"
      BSE_RATE_LIMIT: "2"
      BAN_BACKOFF_SECONDS: "60"
      SCRAPLING_PROXY_URL: ""
    ports:
      - "8200:8200"
    volumes:
      - data_service_cache:/app/data
    healthcheck:
      test: ["CMD", "python", "-c",
             "import httpx; r = httpx.get('http://localhost:8200/health'); r.raise_for_status()"]
      interval: 30s
      timeout: 10s
      start_period: 90s   # Chromium warm-up time
      retries: 3
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
    networks:
      - alphaforge
    depends_on:
      redis:
        condition: service_healthy
```

**`ml-service` additions to existing entry:**
```yaml
    environment:
      # ... existing env vars ...
      DATA_SERVICE_URL: "http://data-service:8200"
    depends_on:
      # ... existing depends_on ...
      data-service:
        condition: service_started  # soft — ML does not fail if data-service is down
```

**New named volume** (appended to existing `volumes:` block):
```yaml
volumes:
  data_service_cache:   # Bhavcopy disk cache + instrument master
```

**Dockerfile:**
```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Install Scrapling with fetcher dependencies (includes Playwright + Chromium)
# This runs during image BUILD — not at container startup — to meet the 90s startup SLA
RUN pip install "scrapling[fetchers]==0.4.*" && scrapling install
COPY src/ ./src/
EXPOSE 8200
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8200"]
```

### Cache Architecture Summary

| Cache type | Key pattern | TTL | Layer |
|---|---|---|---|
| Live quote | `scraping:quote:{exchange}:{symbol}` | 5s | Redis |
| Intraday candles | `scraping:hist:{exchange}:{symbol}:{interval}:{from}:{to}` | 3600s | Redis |
| Option chain | `scraping:chain:{underlying}:{expiry}:{exchange}` | 20s | Redis |
| Daily Bhavcopy | `/app/data/bhavcopy/{exchange}/{symbol}/{date}.csv.gz` | 24h (stat mtime) | Disk |
| Instrument master | `/app/data/instruments/{exchange}.json` | 24h (stat mtime) | Disk |

All caches use the **cache-aside** pattern: check cache → on miss, fetch upstream → write cache → return. Cache writes never block the response path; they are fire-and-forget.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: CORS Origin Rejection

*For any* HTTP request carrying an `Origin` header whose value is not `http://localhost:3000` and not `http://127.0.0.1:3000`, the Data_Service SHALL respond with HTTP 403 and SHALL NOT include an `Access-Control-Allow-Origin` header in the response.

**Validates: Requirements 1.3**

---

### Property 2: Historical Response Structural Invariants

*For any* valid historical candle response from `GET /scraping/historical`, the `count` field SHALL equal the length of the `candles` array, and the `candles` array SHALL be sorted in strictly ascending order by `time` (no two adjacent elements may have the same `time` value).

**Validates: Requirements 2.1**

---

### Property 3: IST-to-UTC Timestamp Conversion Round-Trip

*For any* intraday timestamp `ts_ms` expressed in IST milliseconds, the conversion to UTC epoch seconds `utc_s = (ts_ms / 1000) - 19800` SHALL be invertible: `ts_ms = (utc_s + 19800) * 1000`. The absolute difference between `(utc_s + 19800) * 1000` and the original `ts_ms` SHALL be zero for all integer millisecond inputs.

**Validates: Requirements 2.6**

---

### Property 4: OHLCVCandle Price Invariants

*For any* `OHLCVCandle` returned by any endpoint, ALL of the following SHALL hold simultaneously:
- `high >= max(open, close)`
- `low <= min(open, close)`
- `open > 0`, `high > 0`, `low > 0`, `close > 0`
- `open <= 999_999_999.99`, `high <= 999_999_999.99`, `low <= 999_999_999.99`, `close <= 999_999_999.99`
- `volume >= 0`

**Validates: Requirements 2.7**

---

### Property 5: Quotes Array Positional Alignment

*For any* request to `GET /scraping/quotes` with a `symbols` parameter containing N symbols, the returned `quotes` array SHALL contain exactly N elements where the element at index `i` corresponds to the symbol at position `i` in the input list. The `symbol` field of each non-null entry SHALL match (case-insensitively) the corresponding input symbol.

**Validates: Requirements 3.1**

---

### Property 6: MDQuote Normalization Completeness

*For any* raw NSE XHR quote payload, the normalized `MDQuote` object SHALL contain all of the following fields with the correct types: `symbol` (string), `ltp` (number or null), `change` (number or null), `changePct` (number or null), `open` (number or null), `high` (number or null), `low` (number or null), `prevClose` (number or null), `volume` (integer or null), `oi` (integer or null), `upperCircuit` (number or null), `lowerCircuit` (number or null), `provider` (string equal to `"scrapling"`), and `fetchedAt` (non-empty string). No required field SHALL be absent from the output, regardless of which fields the raw NSE payload omits.

**Validates: Requirements 3.4**

---

### Property 7: PCR Ratio Computation

*For any* option chain with rows where `totalCeOi > 0`, the `analytics.pcrOi` field SHALL equal `round(totalPeOi / totalCeOi, 2)` and SHALL be a non-negative float. When `totalCeOi == 0`, `pcrOi` SHALL be `null`. The same rule applies independently to `pcrVolume`: when `totalCeVolume > 0`, `pcrVolume = round(totalPeVolume / totalCeVolume, 2)`; when `totalCeVolume == 0`, `pcrVolume` is `null`.

**Validates: Requirements 4.5, 4.8**

---

### Property 8: Max Pain Strike Minimises ITM Option Value

*For any* option chain with at least one strike, `analytics.maxPain` SHALL be the strike price `S*` such that the total ITM option value `pain(S*) = Σ_k [max(0, S* - k) × CE_OI_k + max(0, k - S*) × PE_OI_k]` is less than or equal to `pain(S)` for all other strikes `S` in the chain. When multiple strikes share the minimum pain value, `maxPain` SHALL be the one among them with the highest CE OI. For any non-candidate strike `S_other`, `pain(S*) <= pain(S_other)`.

**Validates: Requirements 4.6**

---

### Property 9: ATM IV Is Average of Five Nearest-to-Spot Strike IVs

*For any* option chain with a known spot price and at least 2 option contracts with non-zero OI and non-null IV within the 5 nearest strikes, `analytics.atmIv` SHALL equal the simple arithmetic mean of those contracts' IV values, rounded to 2 decimal places. When fewer than 2 qualifying contracts exist, `atmIv` SHALL be `null`. The 5 nearest strikes are measured by `|strike - spot|` (ascending distance).

**Validates: Requirements 4.7**

---

### Property 10: OI Wall Strikes Are Correct Argmax

*For any* option chain, `analytics.maxCeOiStrike` SHALL be the strike with the strictly highest CE open interest across all rows with a non-null CE contract. Similarly, `analytics.maxPeOiStrike` SHALL be the strike with the strictly highest PE open interest. When multiple strikes tie for maximum OI, the lowest strike price among them SHALL be selected.

**Validates: Requirements 4.9**

---

### Property 11: Tick Publication Channel, Shape, and Null-LTP Skip

*For any* polling cycle where `LiveQuoteScraper` returns a quote for symbol `S` with `ltp != null`, the TickPublisher SHALL publish exactly one message to the Redis channel `af:ticks:{S}` (uppercase `S`) containing a JSON object with all of the following fields present and non-null: `token`, `symbol`, `exchange`, `ltp`, `exchangeTimestampMs`, `receivedAtMs`, and `provider` (equal to `"scrapling"`). *For any* quote where `ltp` is `null` or absent, NO message SHALL be published to `af:ticks:{S}` for that polling cycle, and `publish_count` SHALL NOT be incremented.

**Validates: Requirements 5.1, 5.2, 5.3**

---

### Property 12: Exponential Backoff Sequence on Redis Reconnection

*For any* sequence of N consecutive Redis connection failures (N >= 1), the wait interval before the Nth reconnection attempt SHALL be `min(2^(N-1), 30)` seconds. Specifically: the first wait is 1s, the second is 2s, the third is 4s, ..., and all waits from the 5th attempt onward are capped at 30s. The sequence is reset to 1s immediately after the connection is restored.

**Validates: Requirements 5.7**

---

### Property 13: Tick Listener Forwards Every Valid Message

*For any* JSON-parseable message received on any `af:ticks:*` Redis pub/sub channel, the `onTick` callback SHALL be called exactly once with the parsed `LiveTick` object before the next message from the same channel is processed. The `symbol` field of the `LiveTick` passed to `onTick` SHALL equal the channel suffix (the portion of `af:ticks:{symbol}` after the final `:`).

**Validates: Requirements 6.2**

---

### Property 14: Token Bucket Rate Limit Is Never Exceeded

*For any* sequence of requests through the `TokenBucketRateLimiter` for a domain with configured rate `R` (req/s), the number of requests that actually exit the rate limiter within any contiguous 1-second window SHALL never exceed `ceil(R)`. The constraint must hold regardless of request arrival pattern (burst, uniform, or adversarial).

**Validates: Requirements 9.1**

---

### Property 15: FIFO Queue Preserves Request Arrival Order

*For any* sequence of requests that arrive faster than the configured rate limit and are queued (i.e., no token was available on arrival), the requests SHALL be served in the exact same order they were enqueued. For any two requests `A` and `B` where `A` arrived before `B`, `A`'s completion time SHALL be less than or equal to `B`'s completion time.

**Validates: Requirements 9.2**

---

### Property 16: Ban Detection Pattern Matching Is Complete and Sound

*For any* HTTP response body:
- If the body is a `dict` with `body["records"]["data"] == []` and the current UTC time falls within 03:30–10:30 UTC, then `BanDetector.is_banned(body)` SHALL return `True`.
- If the body is a `str` containing the substring `"window._atsb"`, then `BanDetector.is_banned(body)` SHALL return `True`.
- If the body is a `str` containing the substring `"Too Many Requests"`, then `BanDetector.is_banned(body)` SHALL return `True`.
- If none of the above conditions hold, `BanDetector.is_banned(body)` SHALL return `False`.

**Validates: Requirements 9.4, 9.5, 9.6**

---

### Property 17: DataSourceBadge Display Format

*For any* active provider identifier `p` in `{"scrapling", "angel_one", "upstox", "nse", "yahoo"}` and any non-negative integer `latency_ms`, the DataSourceBadge SHALL render a DOM element containing the text `"{TitleCase(p)} ● {latency_ms}ms"` where `TitleCase` converts underscores to spaces and capitalises each word (e.g., `"angel_one"` → `"Angel One"`). For any provider string not in the five known identifiers, the component SHALL render no DOM element.

**Validates: Requirements 12.1, 12.7**

---

## Error Handling

### Data Service — Python

**Endpoint-level error contract:**

| Condition | HTTP Status | Response body |
|---|---|---|
| Missing or invalid query parameter | 400 | `{"error": "<description>"}` |
| Date range exceeds maximum | 400 | `{"error": "Maximum range is X days for interval Y"}` |
| Upstream timeout (>30s for historical, >10s for quotes, >15s for option chain) | 503 | `{"available": false, "reason": "<message>", "provider": "scrapling"}` |
| Upstream returns error or malformed response | 503 | `{"available": false, "reason": "<message>", "provider": "scrapling"}` |
| Symbol not found or empty date range | 200 | `{"candles": [], "count": 0}` |
| Service component degraded at startup | 200 on `/health` | `{"status": "degraded", "components": {...}}` |
| Service initializing (not yet ready) | 200 | `{"available": false, "reason": "service not yet ready"}` |

**No endpoint ever returns 500.** All internal exceptions are caught and converted to 503 with a descriptive `reason` field. This ensures Docker healthchecks pass and `ScraplingProvider`'s `withRetry` receives a `MarketDataError` (not an unexpected crash).

**Scraper-level retry:** the `AntibanLayer` handles up to 5 ban/challenge retries internally before surfacing a `BanError` to the endpoint handler. The endpoint handler converts `BanError` to 503.

### TypeScript ScraplingProvider — Error Translation

```typescript
async function dsGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { signal });
  if (!res.ok) {
    // Throw MarketDataError so withFailover() moves to Angel One
    throw new MarketDataError(
      `data-service ${path}: HTTP ${res.status}`,
      "scrapling",
      res.status === 429 ? "RATE_LIMIT" :
      res.status === 401 ? "AUTH_FAILURE" :
      "INVALID_RESPONSE"
    );
  }
  return res.json();
}
```

The `withRetry` wrapper in `failover.ts` handles transient failures (up to `RETRY_COUNT=3` attempts with exponential backoff) before `withFailover` moves to Angel One.

### Worker Tick Listener — Fault Isolation

The tick listener is fully isolated from the worker's main job loop:
- JSON parse errors: log warning with channel name + raw content, continue processing
- Subscriber connection errors: log error, set state to stopped, worker continues normally
- `stopScrapingTickListener()` is idempotent — safe to call even if the listener was never started

### ML Service — Tier 0 Fault Tolerance

- HTTP 503/500 or connection error (10s timeout): `logger.warning("scrapling_fetch_failed", ...)`, proceed to Tier 1
- Empty candles array (HTTP 200): proceed to Tier 1 silently
- `DATA_SERVICE_URL` unset: skip Tier 0, begin at Tier 1
- Tier 0 failure never raises an exception to the caller of `get_ohlcv()`

---

## Testing Strategy

### Overview

This feature uses a dual testing approach:
- **Property-based tests** (hypothesis, Python) for the 17 correctness properties above — pure functions with no external dependencies
- **Unit tests** for specific examples, error conditions, and component integration
- **Integration tests** (separate, not run in CI) for end-to-end scraping against live endpoints

Property-based testing applies to the data-service Python layer (pure computation functions: analytics, timestamp conversion, rate limiter, ban detector). The TypeScript ScraplingProvider and worker listener use example-based unit tests with mocked HTTP/Redis.

PBT is not applied to:
- The FastAPI route handlers (HTTP integration — use example tests)
- The `DynamicSession`/`FetcherSession` calls (external I/O — use mocks)
- Docker infrastructure (use smoke tests)
- The React `DataSourceBadge` component (UI rendering — use snapshot tests and example tests)

### Python Property-Based Tests (hypothesis)

**Configuration:** minimum 100 examples per property (default `settings = Settings(max_examples=100)`).

**Tag format** for referencing design properties:
```python
@given(...)
@settings(max_examples=200)
def test_property_N_description(...)
    # Feature: scrapling-data-service, Property N: <property_text>
    ...
```

**Property 3 — IST-to-UTC round-trip (hypothesis example):**
```python
from hypothesis import given, settings
from hypothesis import strategies as st

@given(ts_ms=st.integers(min_value=0, max_value=10**15))
@settings(max_examples=500)
def test_ist_utc_conversion_round_trip(ts_ms):
    # Feature: scrapling-data-service, Property 3: IST-to-UTC timestamp conversion round-trip
    utc_s = (ts_ms / 1000) - 19800
    recovered_ms = (utc_s + 19800) * 1000
    assert abs(recovered_ms - ts_ms) < 1e-9
```

**Property 4 — OHLCVCandle invariants (hypothesis example):**
```python
@given(
    open_=st.floats(min_value=0.01, max_value=999_999_999.0),
    high_delta=st.floats(min_value=0, max_value=1000),
    low_delta=st.floats(min_value=0, max_value=1000),
    close_=st.floats(min_value=0.01, max_value=999_999_999.0),
    volume=st.integers(min_value=0),
)
def test_ohlcv_invariants_hold(open_, high_delta, low_delta, close_, volume):
    # Feature: scrapling-data-service, Property 4: OHLCVCandle price invariants
    high = max(open_, close_) + high_delta
    low = min(open_, close_) - low_delta
    assume(low > 0)
    candle = OHLCVCandle(time=1, open=open_, high=high, low=low, close=close_, volume=volume)
    assert candle.high >= max(candle.open, candle.close)
    assert candle.low <= min(candle.open, candle.close)
    assert candle.volume >= 0
```

**Property 7 — PCR ratio:**
```python
@given(
    ce_oi=st.integers(min_value=0, max_value=10**9),
    pe_oi=st.integers(min_value=0, max_value=10**9),
)
def test_pcr_oi_computation(ce_oi, pe_oi):
    # Feature: scrapling-data-service, Property 7: PCR ratio computation
    result = compute_pcr_oi_from_totals(total_ce_oi=ce_oi, total_pe_oi=pe_oi)
    if ce_oi == 0:
        assert result is None
    else:
        assert result == round(pe_oi / ce_oi, 2)
        assert result >= 0
```

**Property 8 — Max pain:**
```python
@given(
    strikes_and_oi=st.lists(
        st.tuples(
            st.floats(min_value=100, max_value=100_000, allow_nan=False),
            st.integers(min_value=0, max_value=10**7),  # CE OI
            st.integers(min_value=0, max_value=10**7),  # PE OI
        ),
        min_size=1, max_size=50,
    )
)
def test_max_pain_minimises_total_itm_value(strikes_and_oi):
    # Feature: scrapling-data-service, Property 8: maxPain minimises ITM value
    rows = build_option_chain_rows(strikes_and_oi)
    max_pain_strike = compute_max_pain(rows)
    pain_at_max_pain = total_itm_value(rows, max_pain_strike)
    for row in rows:
        assert pain_at_max_pain <= total_itm_value(rows, row.strike)
```

**Property 14 — Token bucket rate limit:**
```python
@given(
    rate=st.floats(min_value=1.0, max_value=20.0),
    requests=st.integers(min_value=1, max_value=100),
)
async def test_token_bucket_never_exceeds_rate(rate, requests):
    # Feature: scrapling-data-service, Property 14: token bucket rate limit
    limiter = TokenBucketRateLimiter("test.com", rate=rate, capacity=rate)
    window_start = asyncio.get_event_loop().time()
    completions = []
    for _ in range(requests):
        await limiter.acquire()
        completions.append(asyncio.get_event_loop().time())
    # Count completions in any 1-second window
    for t in completions:
        window_count = sum(1 for c in completions if t <= c < t + 1.0)
        assert window_count <= math.ceil(rate) + 1  # +1 for floating-point tolerance
```

### TypeScript Unit Tests (Vitest)

**ScraplingProvider:**
```typescript
// tests/lib/market-data/providers/scrapling.test.ts
describe("ScraplingProvider", () => {
  it("getHistoricalCandles: constructs correct URL with query params", ...);
  it("getOptionChain: throws MarketDataError on HTTP 503", ...);
  it("getQuotes: returns array of nulls when DATA_SERVICE_URL is unset", ...);
  it("getInstrumentMaster: returns [] when DATA_SERVICE_URL is unset", ...);
  it("getOptionChain: throws NOT_CONFIGURED when DATA_SERVICE_URL is unset", ...);
  it("subscribe: calls onError and continues polling when getQuotes throws", ...);
  it("is registered at priority 0 when DATA_SERVICE_URL is set", ...);
  it("is not registered when DATA_SERVICE_URL is absent", ...);
});
```

**Worker tick listener:**
```typescript
// tests/worker/scraping-tick-listener.test.ts
describe("ScraplingTickListener", () => {
  it("calls onTick with parsed LiveTick on valid message", ...);
  it("logs warning and continues on JSON parse failure", ...);
  it("stopScrapingTickListener is safe to call when not started", ...);
  it("does not start when scrapingTicks.enabled is false", ...);
});
```

**DataSourceBadge:**
```typescript
// tests/components/india/DataSourceBadge.test.tsx
describe("DataSourceBadge", () => {
  it("renders 'Scrapling ● 180ms' with positive color when provider is scrapling", ...);
  it("renders 'Angel One ● 45ms' with positive color when provider is angel_one", ...);
  it("renders nothing when provider is unknown string", ...);
  it("renders nothing while /api/in/provider-health fetch is in-flight", ...);
  it("cancels in-flight fetch on unmount", ...);
  it("polls exactly 30s after previous response, not on a fixed interval", ...);
});
```

### Python Unit Tests (pytest)

- `test_server.py`: `GET /health` returns 200 + correct shape. `GET /scraping/status` returns `available: true`. CORS headers present for allowed origins, absent for blocked origins.
- `test_historical.py`: mock `FetcherSession.get()` with fixture CSV. Assert correct OHLCV field mapping. Assert disk cache prevents second HTTP call. Assert IST → UTC conversion for intraday timestamps.
- `test_live_quotes.py`: mock `DynamicSession.fetch()` with fixture XHR JSON. Assert correct `MDQuote` mapping. Assert Redis cache write with TTL 5s. Assert null ltp → null in response (not error).
- `test_option_chain.py`: mock XHR fixture. Assert full `OptionChain` shape. Assert `pcrOi`, `maxPain`, `atmIv`, `maxCeOiStrike`, `maxPeOiStrike` computed correctly. Assert fallback to `FetcherSession` on `BrowserError`.
- `test_tick_publisher.py`: mock `aioredis`, assert `PUBLISH` called with `af:ticks:NIFTY` + valid JSON. Assert null ltp skips publish. Assert `publish_count` does not increment for skipped symbols.
- `test_ban_detector.py`: assert all three detection patterns trigger `is_banned() == True`. Assert non-matching body → `False`.
- `test_rate_limiter.py`: assert requests beyond rate limit are queued in FIFO order. Assert queue full error at depth 1000.
- `test_instrument_master.py`: fixture CSV with 10 rows, assert `NIFTY=50`, `BANKNIFTY=15`. Assert hardcoded fallback used when CSV download fails.
- `test_health_route.py`: assert ban counter increments. Assert all monitoring endpoints return correct structure.

### Smoke Tests (Docker / CI)

```bash
# Verify data-service starts and reports healthy within 90s
docker compose up data-service
curl --retry 10 --retry-delay 10 http://localhost:8200/health | jq '.status'

# Verify Redis pub/sub reaches worker
docker compose exec redis redis-cli psubscribe "af:ticks:*"
```

### Integration Tests (Manual / Pre-release only)

Not run in CI — these make real HTTP calls to NSE/BSE:
- `GET http://localhost:8200/scraping/historical?symbol=RELIANCE&exchange=NSE&interval=5m&...`
- `GET http://localhost:8200/scraping/option-chain?underlying=NIFTY&exchange=NSE`
- `GET http://localhost:8200/scraping/quotes?symbols=NIFTY,BANKNIFTY&exchange=NSE`

Tag each integration test with `@pytest.mark.integration` and exclude from the default test run via `pytest -m "not integration"`.
