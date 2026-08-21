# ML Service Runtime Bugs — Bugfix Design

## Overview

Three independent runtime bugs affect the AlphaForge ML service and Yahoo Finance data client. Each bug has a narrow, well-understood root cause that can be fixed with a surgical change — no architectural rework required.

- **Bug 1** (`/predict/regime` → HTTP 422/500): `RegimePredictionRequest` in `ml-service/src/schemas.py` declares ten fields as bare `float` (required by Pydantic). The TypeScript caller only sends the subset of fields it has available, causing Pydantic validation to reject the request body and FastAPI to surface a 422 Unprocessable Entity.

- **Bug 2** (`/predict/price-regime` → HTTP 404 + null guard): The `POST /predict/price-regime` route was added to `server.py` in Phase 2 but the ML service process was not restarted. The separate null-guard sub-bug arises because `mlPost()` in `ml-client.ts` returns `null` on any non-2xx response, and `priceForecast` in `ml-enhanced-context.ts` is already handled correctly — but if the `mlCtxResult` object itself is `null` (due to the outer `.catch(() => null)` in `india-builder.ts`), accessing any property on it without an optional-chain guard would throw a TypeError.

- **Bug 3** (noisy `console.error` for TATAMOTORS): `toYahooSymbol("TATAMOTORS")` produces `TATAMOTORS.NS`, which Yahoo Finance no longer recognises. The error is caught and returns `[]`, but a `console.error` is emitted on every request cycle for a permanently-bad symbol that has no fix other than silence.

---

## Glossary

- **Bug_Condition (C)**: The specific input state that triggers each bug's defective behavior.
- **Property (P)**: The desired correct behavior when C holds — what the fixed code must do.
- **Preservation**: Behavior that must be identical before and after each fix — the regression boundary.
- **RegimePredictionRequest**: The Pydantic schema in `ml-service/src/schemas.py` that validates POST body fields for `POST /predict/regime`.
- **mlPost**: The internal `fetch` wrapper in `src/lib/india/ml-client.ts` that returns `null` on any non-2xx response or network failure.
- **mlCtxResult**: The `MLEnhancedContext | null` value returned by `buildMLContext(...).catch(() => null)` in `india-builder.ts`.
- **priceForecast**: The `PriceForecastResult | null` field on `MLEnhancedContext` populated from `POST /predict/price-regime`.
- **KNOWN_DELISTED**: A hardcoded `Set<string>` of NSE symbols that Yahoo Finance permanently fails to resolve — candidates for silent early-return in `getHistorical`.

---

## Bug Details

### Bug 1 — Regime Endpoint Rejects Partial Feature Bodies

#### Bug Condition

The request body sent by the TypeScript ML client to `POST /predict/regime` may omit any of the ten fields currently declared as required `float` in `RegimePredictionRequest`. Pydantic raises a `ValidationError` for every missing required field; FastAPI wraps this as HTTP 422.

The ten currently-required fields (no `Optional`, no default) are:
```
nifty_change_pct, banknifty_change_pct, india_vix, nifty_atr_pct,
nifty_adx, advance_decline_ratio, market_breadth, sector_strength,
volume_ratio, gap_pct
```

**Formal Specification:**
```
FUNCTION isBugCondition_1(requestBody)
  INPUT: requestBody — JSON object sent to POST /predict/regime
  OUTPUT: boolean

  REQUIRED_FIELDS ← {
    "nifty_change_pct", "banknifty_change_pct", "india_vix",
    "nifty_atr_pct", "nifty_adx", "advance_decline_ratio",
    "market_breadth", "sector_strength", "volume_ratio", "gap_pct"
  }
  RETURN EXISTS field IN REQUIRED_FIELDS WHERE field NOT IN requestBody
END FUNCTION
```

#### Examples

- **Bug triggers**: TypeScript caller sends `{nifty_change_pct: 0.5, india_vix: 14.2, ...}` omitting `advance_decline_ratio` — Pydantic rejects with 422, caller receives null, ML regime is unavailable.
- **Bug triggers**: `buildMLContext` is called with `advanceDeclineRatio: undefined` → `advance_decline_ratio` is not included in the serialized JSON body.
- **Bug does NOT trigger**: All ten required fields are present in the request body — Pydantic validates successfully, regime is returned.
- **Edge case**: All ten fields provided but `advance_decline_ratio` is `0.0` — this must NOT be treated as missing (zero is a valid value).

---

### Bug 2 — price-regime 404 and Downstream Null Guard

#### Bug Condition (Part A — 404)

The ML service process that was running before `POST /predict/price-regime` was added to `server.py` never saw the new route registration. The fix is a service restart; there is no code change to `server.py` (the route is already correctly defined).

```
FUNCTION isBugCondition_2a(serviceState)
  INPUT: serviceState — the running ML service process
  OUTPUT: boolean

  RETURN "/predict/price-regime" NOT IN registeredRoutes(serviceState)
END FUNCTION
```

#### Bug Condition (Part B — Null Guard)

When `mlPost("/predict/price-regime", ...)` returns `null` (404 or any error), the `priceForecast` field on `MLEnhancedContext` is correctly set to `null`. However, `buildMLContext` is called in `india-builder.ts` with `.catch(() => null)`, so `mlCtxResult` itself can be `null`. Any code path that accesses `mlCtxResult.priceForecast` (or any other field) without first checking `mlCtxResult != null` will throw a TypeError.

```
FUNCTION isBugCondition_2b(mlCtxResult)
  INPUT: mlCtxResult — return value of buildMLContext().catch(() => null)
  OUTPUT: boolean

  RETURN mlCtxResult IS null
         AND callerAccessesPropertyOf(mlCtxResult) WITHOUT null-check
END FUNCTION
```

#### Examples

- **Bug 2a triggers**: ML service is running with a pre-Phase-2 process → `POST /predict/price-regime` → 404.
- **Bug 2a does NOT trigger**: ML service is restarted after Phase 2 changes → route is registered → 200 or heuristic fallback.
- **Bug 2b triggers**: `buildMLContext` throws unexpectedly → `.catch(() => null)` → `mlCtxResult` is `null` → accessing `mlCtxResult.priceForecast` without optional chain → TypeError.
- **Bug 2b does NOT trigger**: `mlCtxResult` is a valid `MLEnhancedContext` object → all property accesses safe.

---

### Bug 3 — TATAMOTORS Noisy console.error

#### Bug Condition

`getHistorical` is called with a symbol whose Yahoo Finance ticker is permanently invalid (renamed, delisted, or otherwise unresolvable). `yahoo-finance2` throws an error; it is caught and `[]` is returned. The `console.error` call is in the catch block and fires on every request cycle.

```
FUNCTION isBugCondition_3(symbol)
  INPUT: symbol — NSE-style ticker string (e.g. "TATAMOTORS")
  OUTPUT: boolean

  KNOWN_DELISTED ← { "TATAMOTORS" }
  RETURN symbol IN KNOWN_DELISTED
END FUNCTION
```

#### Examples

- **Bug triggers**: `getHistorical({ symbol: "TATAMOTORS", ... })` → `TATAMOTORS.NS` not recognised → `console.error("yahoo.getHistorical(TATAMOTORS): No data found…")` on every scan cycle.
- **Bug does NOT trigger**: `getHistorical({ symbol: "RELIANCE", ... })` → `RELIANCE.NS` resolves correctly → no error.
- **Edge case**: A symbol not in `KNOWN_DELISTED` that fails transiently → `console.error` still fires (correct — this is not a known-permanent failure).

---

## Expected Behavior

### Preservation Requirements

**Bug 1 — Unchanged Behaviors:**
- WHEN all ten required fields are present in the request body THEN the system SHALL continue to validate and process the regime prediction exactly as before — no change to validation logic for complete bodies.
- The `model_dump(exclude_none=True)` call in `predict_regime()` route handler is unchanged — omitted `Optional` fields are still excluded from the feature dict passed to the classifier.
- All other endpoints (`/predict/rankings`, `/predict/strategy`, `/predict/risk`, etc.) are not touched and continue to function unchanged.

**Bug 2 — Unchanged Behaviors:**
- WHEN `mlPost` returns a valid non-null response THEN the system SHALL continue to use the forecast data exactly as before.
- The existing `try/catch` around `priceForecast` in `ml-enhanced-context.ts` is unchanged — graceful degradation when the endpoint throws is preserved.
- All other `mlCtxResult` accesses already using optional chaining (`?.`) in `india-builder.ts` are not changed.

**Bug 3 — Unchanged Behaviors:**
- WHEN `getHistorical` is called with a valid, actively-traded symbol THEN the system SHALL continue to fetch and return OHLCV candles exactly as before.
- WHEN `getHistorical` encounters a genuine transient error for a symbol NOT in `KNOWN_DELISTED` THEN the system SHALL continue to call `console.error` so real failures remain visible.
- The `KNOWN_DELISTED` set is intentionally narrow (one entry for now). No other logic in `YahooAdapter` is modified.

---

## Hypothesized Root Cause

### Bug 1

1. **Required fields with no defaults**: `RegimePredictionRequest` was designed for a full feature vector scenario. When the TypeScript caller was written, the ten core fields were marked required (no `Optional[float]`, no `= None` default). The TypeScript `predictRegime()` function signature shows all ten as required `number` properties, but the `buildMLContext()` call passes `advanceDeclineRatio: clamp(...)` (a number) and `marketBreadth: 50` (hardcoded) — these are always present. However, other call sites or future callers may not always supply all ten fields, and the schema prevents graceful partial-body handling.

   **Real risk now**: The `buildMLContext` call in `india-builder.ts` passes `niftyAtrPct: 1.0` (rough proxy) — but this is a hardcoded sentinel, not `undefined`. The schema's requirement that all ten fields are present is fragile; the principled fix is to make all ten `Optional[float] = None` with heuristic fallback in `_predict_heuristic`.

2. **Pydantic strict validation by default**: With no default values set, Pydantic raises `ValidationError` for any missing field regardless of whether the field would have a sensible zero/fallback value.

### Bug 2

1. **Process not restarted**: The `POST /predict/price-regime` route and `PriceRegimeRequest` schema were added to `server.py` during Phase 2 development, but the ML service process (`uvicorn` or equivalent) was not restarted. Python imports routes only at startup.

2. **Outer null propagation**: `buildMLContext` is an `async` function called with `.catch(() => null)`. If the function itself throws (network issue, import error, etc.), `mlCtxResult` becomes `null`. In `india-builder.ts` lines 1583–1594, existing accesses already use optional chaining (`mlCtxResult?.rankings?.rankings`, `mlCtxResult?.mlAvailable`). However, any future access to `mlCtxResult.priceForecast` added without `?.` would crash.

### Bug 3

1. **No denylist before network call**: `getHistorical` calls `toYahooSymbol(req.symbol)` which appends `.NS` to plain symbols, then makes the `yf.chart()` request. For `TATAMOTORS`, this produces `TATAMOTORS.NS` which Yahoo's data API does not recognise (the stock trades under a different ticker on Yahoo). The error is caught and `[]` is returned, but the `console.error` in the catch block was designed for unexpected failures — it is too noisy for known-permanent symbol mismatches.

---

## Correctness Properties

Property 1: Bug Condition — Partial Regime Request Accepted

_For any_ request body sent to `POST /predict/regime` where `isBugCondition_1` returns true (one or more of the ten formerly-required fields is absent), the fixed `RegimePredictionRequest` schema SHALL accept the body and the endpoint SHALL return HTTP 200 with a valid `RegimePredictionResponse` containing a `regime`, `confidence`, and `probabilities` map — using heuristic fallback values for the missing fields.

**Validates: Requirements 2.1**

Property 2: Preservation — Complete Regime Request Unchanged

_For any_ request body sent to `POST /predict/regime` where `isBugCondition_1` returns false (all ten fields present), the fixed schema SHALL produce exactly the same prediction as the original schema — no change to validation, feature extraction, or model inference for complete bodies.

**Validates: Requirements 3.1**

Property 3: Bug Condition — price-regime Route Available After Restart

_For any_ POST to `/predict/price-regime` after the ML service process has been restarted (so the route is registered), the fixed service SHALL return HTTP 200 with a valid response of shape `{regime, probability, q10, q90}` — never 404.

**Validates: Requirements 2.2**

Property 4: Bug Condition — Null priceForecast Handled Defensively

_For any_ execution path in `india-builder.ts` where `mlCtxResult` is `null` (because `buildMLContext` threw and `.catch(() => null)` fired), the fixed code SHALL NOT access any property of `mlCtxResult` without an optional-chain guard, and SHALL NOT throw a TypeError.

**Validates: Requirements 2.3**

Property 5: Preservation — Non-null mlCtxResult Behavior Unchanged

_For any_ execution path where `mlCtxResult` is a valid `MLEnhancedContext` (service healthy, `priceForecast` is either a `PriceForecastResult` or `null`), the fixed code SHALL produce the same blended regime score, ML rank boosts, and signal set as the original code.

**Validates: Requirements 3.2, 3.3**

Property 6: Bug Condition — KNOWN_DELISTED Symbol Returns Silently

_For any_ call to `getHistorical` where `isBugCondition_3(symbol)` is true, the fixed function SHALL return `[]` without calling `console.error` and without making any network request to Yahoo Finance.

**Validates: Requirements 2.4**

Property 7: Preservation — Valid Symbol Behavior Unchanged

_For any_ call to `getHistorical` where `isBugCondition_3(symbol)` is false, the fixed function SHALL behave identically to the original — including calling `console.error` on transient fetch errors for symbols not in the denylist.

**Validates: Requirements 3.4, 3.5**

---

## Fix Implementation

### Bug 1 — `ml-service/src/schemas.py`

**File**: `ml-service/src/schemas.py`
**Class**: `RegimePredictionRequest`

**Specific Changes**:
1. **Make all ten core fields Optional with `None` defaults**: Change each bare `float = Field(...)` to `Optional[float] = Field(default=None, ...)`. This allows Pydantic to accept a request body that omits any subset of these fields.
2. **No change to `_predict_heuristic`**: The heuristic in `MarketRegimeClassifier` already uses `.get(key, default)` on the feature dict, so it already handles absent values gracefully. The `predict_regime` route already calls `request.model_dump(exclude_none=True)` which strips `None` values before passing to the classifier.

```python
# Before
nifty_change_pct: float = Field(description="NIFTY 50 intraday % change")
advance_decline_ratio: float = Field(description="NSE advance/decline ratio")
# ... (all ten)

# After
nifty_change_pct: Optional[float] = Field(default=None, description="NIFTY 50 intraday % change")
advance_decline_ratio: Optional[float] = Field(default=None, description="NSE advance/decline ratio")
# ... (all ten made Optional with default=None)
```

### Bug 2a — ML Service Process Restart

**File**: N/A (operational fix — no code change)

**Specific Changes**:
1. **Restart the ML service**: Run `docker-compose restart ml-service` (or equivalent) so the FastAPI app re-imports `server.py` and registers the `POST /predict/price-regime` route.
2. **Verify**: `curl -s http://localhost:8100/predict/price-regime -X POST -H "Content-Type: application/json" -d '{"last_60_bars": []}' | jq .regime` should return `"flat"` (or `"bull"` / `"bear"`) from the heuristic fallback.

### Bug 2b — `src/lib/india/ml-enhanced-context.ts` (null guard)

**File**: `src/lib/india/ml-enhanced-context.ts`

The fix is already defensively coded — `priceForecast` is wrapped in a `try/catch` and defaults to `null`. The `MLEnhancedContext.priceForecast` field is typed `PriceForecastResult | null`.

**File**: `src/features/ai-signals/india-builder.ts`

**Specific Changes**:
1. **Verify optional-chain guard on `priceForecast` access**: Any code that reads `mlCtxResult.priceForecast` must use `mlCtxResult?.priceForecast` since `mlCtxResult` can be `null`. The existing accesses at lines 1583–1594 already use `?.` — confirm any new access added for the priceForecast integration also uses optional chaining.

```typescript
// Before (unsafe — would crash if mlCtxResult is null)
const forecastRegime = mlCtxResult.priceForecast?.regime;

// After (safe)
const forecastRegime = mlCtxResult?.priceForecast?.regime;
```

### Bug 3 — `src/services/india/yahoo/index.ts`

**File**: `src/services/india/yahoo/index.ts`
**Method**: `YahooAdapter.getHistorical`

**Specific Changes**:
1. **Add `KNOWN_DELISTED` constant at module level**: A `Set<string>` containing NSE symbols known to be permanently unresolvable on Yahoo Finance.
2. **Early-return guard at the top of `getHistorical`**: Before the cache lookup and before any Yahoo network call, check if the symbol is in `KNOWN_DELISTED`. If so, return `[]` immediately without logging.

```typescript
// New constant (module-level, above the class)
const KNOWN_DELISTED = new Set<string>([
  "TATAMOTORS", // renamed on Yahoo Finance; TATAMOTORS.NS not recognised
]);

// Inside getHistorical, before the cache.memo call:
async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
  if (KNOWN_DELISTED.has(req.symbol)) return [];
  // ... rest of existing implementation unchanged
}
```

---

## Testing Strategy

### Validation Approach

Testing follows a two-phase approach: first, run exploratory tests against the **unfixed** code to confirm the bugs reproduce as described and surface counterexamples. Then fix the code and run fix-checking + preservation tests to verify correctness.

### Exploratory Bug Condition Checking

**Goal**: Confirm each bug condition reproduces on unfixed code. Counterexamples here are *expected failures* — they validate our root cause analysis.

**Test Plan**:

**Bug 1 Exploration:**
- Send `POST /predict/regime` with a body that omits `advance_decline_ratio` to the unfixed ML service.
- Expected: HTTP 422 with Pydantic validation error in the response body.
- Confirms: the root cause is missing `Optional` defaults.

**Bug 2a Exploration:**
- Send `POST /predict/price-regime` to the ML service without restarting it.
- Expected: HTTP 404 `{"detail": "Not Found"}`.
- Confirms: the route is not registered in the running process.

**Bug 2b Exploration:**
- Mock `buildMLContext` to throw → observe that `.catch(() => null)` fires → access `mlCtxResult.priceForecast` (without `?.`) → observe TypeError.
- Confirms: the null propagation path exists.

**Bug 3 Exploration:**
- Call `yahoo.getHistorical({ symbol: "TATAMOTORS", interval: "1d", range: "1y" })` on unfixed code.
- Expected: `[]` returned + `console.error("yahoo.getHistorical(TATAMOTORS): No data found…")` emitted.
- Confirms: the error path is triggered on every call for a known-bad symbol.

**Test Cases**:
1. **Partial body regime request** — omit `advance_decline_ratio` → expect 422 (will fail on unfixed code)
2. **price-regime 404** — call route before restart → expect 404 (will fail once service is restarted/fixed)
3. **Null mlCtxResult property access** — mock throw → expect TypeError on unsafe `.priceForecast` access (will fail on unguarded code)
4. **TATAMOTORS noisy error** — call `getHistorical("TATAMOTORS")` → observe `console.error` call count (will be 1 on unfixed code, 0 after fix)

**Expected Counterexamples:**
- Bug 1: `422 Unprocessable Entity` with body `{"detail": [{"type": "missing", "loc": ["body", "advance_decline_ratio"], ...}]}`
- Bug 2a: `404 Not Found`
- Bug 2b: `TypeError: Cannot read properties of null (reading 'priceForecast')`
- Bug 3: `console.error` called with message containing `"TATAMOTORS"` and `"No data found"`

### Fix Checking

**Bug 1 — Fix Checking:**
```
FOR ALL requestBody WHERE isBugCondition_1(requestBody) DO
  response ← POST /predict/regime_fixed(requestBody)
  ASSERT response.status = 200
  ASSERT response.body.regime IN VALID_REGIMES
  ASSERT response.body.confidence IN [0, 1]
END FOR
```

**Bug 2a — Fix Checking:**
```
FOR ALL state WHERE serviceIsRestarted(state) DO
  response ← POST /predict/price-regime_fixed({ last_60_bars: [] })
  ASSERT response.status = 200
  ASSERT response.body.regime IN { "bull", "bear", "flat" }
  ASSERT response.body.probability IN [0, 1]
END FOR
```

**Bug 2b — Fix Checking:**
```
FOR ALL execution WHERE mlCtxResult IS null DO
  ASSERT accessing mlCtxResult?.priceForecast = undefined   // no TypeError
END FOR
```

**Bug 3 — Fix Checking:**
```
FOR ALL symbol WHERE isBugCondition_3(symbol) DO
  consoleSpy ← spy(console.error)
  result ← yahoo.getHistorical_fixed({ symbol, interval: "1d", range: "1y" })
  ASSERT result = []
  ASSERT consoleSpy.callCount = 0
END FOR
```

### Preservation Checking

**Goal**: Verify that non-buggy inputs produce identical output before and after each fix.

```
// Bug 1
FOR ALL requestBody WHERE NOT isBugCondition_1(requestBody) DO
  ASSERT POST /predict/regime_fixed(requestBody) = POST /predict/regime_original(requestBody)
END FOR

// Bug 2b  
FOR ALL mlCtxResult WHERE mlCtxResult IS NOT null DO
  ASSERT behavior_fixed(mlCtxResult) = behavior_original(mlCtxResult)
END FOR

// Bug 3
FOR ALL symbol WHERE NOT isBugCondition_3(symbol) DO
  ASSERT getHistorical_fixed(symbol) = getHistorical_original(symbol)
END FOR
```

**Testing Approach**: Property-based testing is particularly well-suited for:
- Bug 1 preservation: generate random complete request bodies and verify the ML service response is identical before/after the `Optional` change.
- Bug 3 preservation: generate random valid NSE symbols and verify `getHistorical` behavior is unchanged (same return value and same `console.error` behavior on genuine failures).

### Unit Tests

**Bug 1:**
- `POST /predict/regime` with each of the ten fields individually omitted — all should return 200 after fix.
- `POST /predict/regime` with all ten fields present — response must be identical to pre-fix.
- `POST /predict/regime` with an empty body `{}` — should return 200 with a fully heuristic-derived regime.

**Bug 2:**
- Mock `buildMLContext` to return `null` → verify `india-builder` does not throw.
- Mock `/predict/price-regime` to return 404 → verify `priceForecast` is `null` on the context object.
- Mock `/predict/price-regime` to return a valid response → verify `priceForecast.regime` is set correctly.

**Bug 3:**
- `getHistorical({ symbol: "TATAMOTORS", ... })` → returns `[]`, no `console.error`.
- `getHistorical({ symbol: "RELIANCE", ... })` (mocked to succeed) → returns candles, no change in behavior.
- `getHistorical({ symbol: "UNKNOWNXYZ", ... })` (mocked to throw) → still calls `console.error` (not in denylist).

### Property-Based Tests

**Bug 1 (Python — Hypothesis):**
- Generate random partial bodies (random subset of the ten fields, values drawn from realistic ranges) and assert `POST /predict/regime` returns 200 with a valid regime enum value.
- Generate random complete bodies and assert the response is structurally identical to the pre-fix behavior (same shape, same regime for deterministic heuristic paths).

**Bug 3 (TypeScript — fast-check):**
- Generate random non-denylist symbols and verify `getHistorical` behavior is unchanged (mock the Yahoo `yf.chart` call, verify `console.error` is still called on errors and not called on success — exactly as before).
- Verify that adding more symbols to `KNOWN_DELISTED` does not affect symbols outside the set.

### Integration Tests

**Bug 1:**
- Start the ML service; call `buildMLContext` from `ml-enhanced-context.ts` with a realistic partial-feature call (as `india-builder.ts` does) — verify regime is returned rather than `null`.
- Verify the `POST /predict/regime` response body shape matches `RegimePredictionResponse`.

**Bug 2:**
- Restart ML service; call `POST /predict/price-regime` → verify 200 with valid shape.
- Call `computeIndiaUniverse` with `buildMLContext` returning a context with `priceForecast = null` → verify full signal generation pipeline completes without error.

**Bug 3:**
- Run `getIndiaDailyPickCandidates()` (which fans out across the full F&O universe including TATAMOTORS) and verify no `console.error` is emitted for TATAMOTORS while errors for other genuinely-failing symbols are still logged.
