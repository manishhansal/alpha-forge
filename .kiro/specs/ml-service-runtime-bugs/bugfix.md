# Bugfix Requirements Document

## Introduction

Three runtime bugs were identified in the AlphaForge trading application logs. They affect the ML service and the Yahoo Finance data client:

1. **Bug 1 — `/predict/regime` returns HTTP 500**: The `RegimePredictionRequest` Pydantic schema has ten required (non-Optional) fields. The TypeScript caller in `ml-client.ts` only sends the fields it has assembled, omitting fields like `advance_decline_ratio`, `market_breadth`, `sector_strength`, etc. when they are unavailable. Pydantic rejects the incomplete body with a 422 Unprocessable Entity that FastAPI surfaces as a 500-range error to the caller.

2. **Bug 2 — `/predict/price-regime` returns HTTP 404**: The `POST /predict/price-regime` endpoint was added to `server.py` as part of Phase 2, but the ML service process was never restarted after the new route was registered. Any HTTP 404 from the ML service currently falls through `mlPost` as a generic warn with `null` returned; the `priceForecast` field consumed by callers is not defensively guarded for `null`, which can cause a runtime error downstream.

3. **Bug 3 — `yahoo.getHistorical(TATAMOTORS)` logs "No data found, symbol may be delisted"**: `toYahooSymbol("TATAMOTORS")` produces `"TATAMOTORS.NS"`, which Yahoo Finance does not recognise (the stock was renamed / has a different ticker). The error is caught and returns `[]`, so trading is non-fatal, but a noisy `console.error` is emitted on every request cycle for a known-bad symbol. There is no alias map or denylist to silence it.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the TypeScript ML client calls `POST /predict/regime` with a partial feature dict that omits one or more of the ten required `RegimePredictionRequest` fields THEN the system returns HTTP 500 and logs a Pydantic validation error

1.2 WHEN the ML service is started (or restarted) after the `POST /predict/price-regime` route was added to `server.py` THEN the system returns HTTP 404 for `POST /predict/price-regime`

1.3 WHEN `priceForecast` is `null` (because `/predict/price-regime` returned 404 or any other non-2xx status) AND the caller in `india-builder.ts` accesses a property on `priceForecast` without a null guard THEN the system throws a runtime TypeError

1.4 WHEN `yahoo.getHistorical` is called with symbol `TATAMOTORS` THEN the system logs `console.error("yahoo.getHistorical(TATAMOTORS): No data found, symbol may be delisted")` on every request cycle even though the rename is a known, permanent condition

### Expected Behavior (Correct)

2.1 WHEN the TypeScript ML client calls `POST /predict/regime` with a partial feature dict that omits optional fields THEN the system SHALL accept the request and return a valid `RegimePredictionResponse` (using heuristic fallback values for missing inputs)

2.2 WHEN the ML service process is running with the current `server.py` (which includes `POST /predict/price-regime`) THEN the system SHALL respond with a valid price-regime prediction (or its rule-based fallback) and SHALL NOT return 404

2.3 WHEN `/predict/price-regime` returns a non-2xx status (including 404) AND `mlPost` returns `null` THEN the system SHALL handle `null` priceForecast defensively and SHALL NOT throw a TypeError at the call site in `india-builder.ts`

2.4 WHEN `yahoo.getHistorical` is called with a symbol that is in the known-delisted or known-renamed denylist THEN the system SHALL return `[]` silently, without emitting a `console.error`

### Unchanged Behavior (Regression Prevention)

3.1 WHEN all ten required `RegimePredictionRequest` fields are present in the request body THEN the system SHALL CONTINUE TO validate and process the regime prediction exactly as before

3.2 WHEN the ML service is running with all previously registered routes (`/predict/regime`, `/predict/rankings`, `/predict/strategy`, `/predict/risk`, `/predict/portfolio`, `/predict/execution`) THEN the system SHALL CONTINUE TO serve those endpoints without disruption

3.3 WHEN `mlPost` returns a valid non-null `priceForecast` THEN the system SHALL CONTINUE TO use the forecast data as before

3.4 WHEN `yahoo.getHistorical` is called with a valid, actively-traded NSE symbol (e.g. `RELIANCE`, `INFY`) THEN the system SHALL CONTINUE TO fetch and return OHLCV candles as before

3.5 WHEN `yahoo.getHistorical` encounters a genuine transient fetch error for a symbol not in the denylist THEN the system SHALL CONTINUE TO log `console.error` so legitimate failures remain visible

---

## Bug Condition Pseudocode

### Bug 1 — Regime endpoint partial-body 500

```pascal
FUNCTION isBugCondition_1(request)
  INPUT: request of type RegimePredictionRequest payload
  OUTPUT: boolean

  RETURN EXISTS field IN REQUIRED_FIELDS(RegimePredictionRequest)
         WHERE field NOT IN request AND field IS NOT Optional
END FUNCTION

// Property: Fix Checking
FOR ALL request WHERE isBugCondition_1(request) DO
  result ← POST /predict/regime(request)'
  ASSERT result.status = 200
  AND result.body.regime IS VALID MarketRegime
END FOR

// Property: Preservation Checking
FOR ALL request WHERE NOT isBugCondition_1(request) DO
  ASSERT POST /predict/regime(request)' = POST /predict/regime(request)
END FOR
```

### Bug 2 — price-regime 404 and null guard

```pascal
FUNCTION isBugCondition_2(mlServiceState)
  INPUT: mlServiceState — the running ML service process state
  OUTPUT: boolean

  RETURN "/predict/price-regime" NOT IN registeredRoutes(mlServiceState)
         OR priceForecast IS null AND callerAccessesPropertyOf(priceForecast)
END FUNCTION

// Property: Fix Checking
FOR ALL state WHERE isBugCondition_2(state) DO
  result ← POST /predict/price-regime(validBody)'
  ASSERT result.status IN {200}
  nullResult ← mlPost("/predict/price-regime", validBody) RETURNS null
  ASSERT caller HANDLES nullResult WITHOUT TypeError
END FOR
```

### Bug 3 — TATAMOTORS denylist

```pascal
FUNCTION isBugCondition_3(symbol)
  INPUT: symbol of type string
  OUTPUT: boolean

  RETURN symbol IN KNOWN_DELISTED_OR_RENAMED_SYMBOLS
END FUNCTION

// Property: Fix Checking
FOR ALL symbol WHERE isBugCondition_3(symbol) DO
  result ← yahoo.getHistorical'({ symbol, ... })
  ASSERT result = []
  AND console.error WAS NOT CALLED
END FOR

// Property: Preservation Checking
FOR ALL symbol WHERE NOT isBugCondition_3(symbol) DO
  ASSERT yahoo.getHistorical'(symbol) = yahoo.getHistorical(symbol)
END FOR
```
