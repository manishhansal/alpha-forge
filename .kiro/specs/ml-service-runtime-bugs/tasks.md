# Implementation Plan

<!-- Covers three independent runtime bugs: Bug 1 (regime 422/500), Bug 2 (price-regime 404 + null guard), Bug 3 (TATAMOTORS noisy error) -->

- [x] 1. Write bug condition exploration tests (all three bugs)
  - **Property 1: Bug Condition** - Partial Regime Body, price-regime Null Guard, TATAMOTORS Denylist
  - **CRITICAL**: Write these tests BEFORE implementing any fix — expected failures confirm bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **GOAL**: Surface counterexamples that demonstrate each bug exists
  - **Scoped PBT Approach**: Scope each property to the concrete failing case to ensure reproducibility

  **Bug 1 — `ml-service/tests/test_schemas_optional.py` (Hypothesis)**
  - Use `@given(st.fixed_dictionaries({...}))` with a strategy that randomly drops one or more of the ten required fields from a valid complete body
  - For each generated partial body, call `RegimePredictionRequest(**body)` (or `POST /predict/regime` via TestClient)
  - Assert the request is accepted (no `ValidationError` raised, HTTP 200)
  - isBugCondition_1: `EXISTS field IN REQUIRED_FIELDS WHERE field NOT IN requestBody`
  - Run on UNFIXED code → **EXPECTED OUTCOME: Test FAILS** (Pydantic raises `ValidationError` for missing required field)
  - Concrete failing case to document: body omitting `advance_decline_ratio` → `ValidationError: 1 validation error for RegimePredictionRequest, advance_decline_ratio — Field required`

  **Bug 2b — `tests/features/india/india-builder-null-guard.test.ts` (Vitest)**
  - Mock `buildMLContext` to throw a simulated network error (so `.catch(() => null)` fires and `mlCtxResult` becomes `null`)
  - Access `mlCtxResult?.priceForecast?.regime` on the null result
  - Assert no TypeError is thrown and the value is `undefined` (not a crash)
  - isBugCondition_2b: `mlCtxResult IS null AND callerAccessesPropertyOf(mlCtxResult) WITHOUT null-check`
  - Run on UNFIXED code → **EXPECTED OUTCOME: Test FAILS** if any unsafe `.priceForecast` access exists without `?.`
  - Concrete failing case: `mlCtxResult.priceForecast` (no optional chain) on null → `TypeError: Cannot read properties of null`

  **Bug 3 — `tests/services/india/yahoo-denylist.test.ts` (Vitest)**
  - Spy on `console.error` with `vi.spyOn(console, 'error')`
  - Call `getHistorical({ symbol: 'TATAMOTORS', interval: '1d', range: '1y' })` on unfixed code
  - Assert `console.error` was called at least once with a message containing `"TATAMOTORS"` and `"No data found"`
  - isBugCondition_3: `symbol IN KNOWN_DELISTED` where `KNOWN_DELISTED = { "TATAMOTORS" }`
  - Run on UNFIXED code → **EXPECTED OUTCOME: Test assertion passes** (confirms bug — error IS logged)
  - (The fix-checking phase asserts 0 calls; here we confirm 1+ call to document the bug)
  - Document counterexample: `getHistorical({ symbol: 'TATAMOTORS', ... })` → `console.error` called with `"No data found, symbol may be delisted"`

  - Mark task complete when all three exploration tests are written, run, and failures/counterexamples are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing any fix)
  - **Property 2: Preservation** - Complete Regime Bodies, Non-null mlCtxResult, Valid Yahoo Symbols
  - **IMPORTANT**: Follow observation-first methodology — observe unfixed behavior, then encode it as tests
  - **GOAL**: Establish the regression boundary before touching any code

  **Bug 1 preservation — `ml-service/tests/test_schemas_optional.py` (Hypothesis)**
  - Use `@given(st.fixed_dictionaries({all ten fields: st.floats(...)}))` to generate complete bodies (isBugCondition_1 returns false)
  - Call `POST /predict/regime` (via FastAPI TestClient) with each complete body
  - Assert response status is 200 and response body contains `regime`, `confidence`, `probabilities`
  - Observe and record: on unfixed code with all ten fields present, the endpoint returns 200 with a valid `RegimePredictionResponse`
  - Run on UNFIXED code → **EXPECTED OUTCOME: Tests PASS** (confirms complete bodies work before fix)
  - _Requirements: 3.1_

  **Bug 2 preservation — `tests/features/india/india-builder-null-guard.test.ts` (Vitest)**
  - Mock `buildMLContext` to return a valid `MLEnhancedContext` object (mlCtxResult is NOT null)
  - Verify existing accesses (`mlCtxResult?.rankings`, `mlCtxResult?.mlAvailable`, `mlCtxResult?.priceForecast`) all resolve correctly
  - Assert the blended regime score and signal generation pipeline produce the same output as before
  - Observe: on unfixed code with non-null mlCtxResult, all optional-chain accesses return expected values without error
  - Run on UNFIXED code → **EXPECTED OUTCOME: Tests PASS** (confirms non-null path is safe before fix)
  - _Requirements: 3.2, 3.3_

  **Bug 3 preservation — `tests/services/india/yahoo-denylist.test.ts` (Vitest, fast-check)**
  - For valid symbols (e.g., `RELIANCE`, `INFY`): mock `yf.chart` to return dummy candles, verify `getHistorical` returns them and `console.error` is NOT called
  - For a non-denylist symbol with a simulated transient error: mock `yf.chart` to throw, verify `getHistorical` returns `[]` AND `console.error` IS called (current behavior to preserve)
  - Optionally use `fc.property(fc.string().filter(s => !['TATAMOTORS'].includes(s)), ...)` for the transient-error case
  - Observe: on unfixed code, valid symbols return candles; non-denylist errors still log via console.error
  - Run on UNFIXED code → **EXPECTED OUTCOME: Tests PASS** (confirms baseline before fix)
  - _Requirements: 3.4, 3.5_

  - Mark task complete when all preservation tests are written, run, and passing on unfixed code

- [x] 3. Fix Bug 1 — Make RegimePredictionRequest fields Optional

  - [x] 3.1 Update `ml-service/src/schemas.py` — make all ten fields `Optional[float] = Field(default=None, ...)`
    - Change `nifty_change_pct: float = Field(...)` → `nifty_change_pct: Optional[float] = Field(default=None, ...)`
    - Apply the same change to all ten fields: `banknifty_change_pct`, `india_vix`, `nifty_atr_pct`, `nifty_adx`, `advance_decline_ratio`, `market_breadth`, `sector_strength`, `volume_ratio`, `gap_pct`
    - Ensure `from typing import Optional` is present at the top of the file
    - No change to the `predict_regime` route handler — it already calls `request.model_dump(exclude_none=True)` which strips `None` values before passing to the classifier
    - No change to `_predict_heuristic` — it already uses `.get(key, default)` on the feature dict
    - _Bug_Condition: isBugCondition_1(requestBody) where EXISTS field IN REQUIRED_FIELDS WHERE field NOT IN requestBody_
    - _Expected_Behavior: POST /predict/regime with partial body returns HTTP 200 with valid RegimePredictionResponse_
    - _Preservation: Complete bodies (all ten fields present) must produce identical predictions as before_
    - _Requirements: 2.1, 3.1_

  - [x] 3.2 Verify Bug 1 exploration test now passes
    - **Property 1: Expected Behavior** - Partial Regime Body Accepted
    - **IMPORTANT**: Re-run the SAME Hypothesis test from task 1 — do NOT write a new test
    - The test from task 1 asserts partial bodies are accepted with HTTP 200
    - Run: `cd ml-service && python -m pytest tests/test_schemas_optional.py -v`
    - **EXPECTED OUTCOME: Test PASSES** (confirms Pydantic no longer rejects partial bodies)
    - _Requirements: 2.1_

  - [x] 3.3 Verify Bug 1 preservation tests still pass
    - **Property 2: Preservation** - Complete Regime Bodies Unchanged
    - **IMPORTANT**: Re-run the SAME Hypothesis preservation test from task 2 — do NOT write new tests
    - Run: `cd ml-service && python -m pytest tests/test_schemas_optional.py -v -k "preservation"`
    - **EXPECTED OUTCOME: Tests PASS** (confirms complete bodies still work identically)

- [x] 4. Fix Bug 2a — Document ML service restart (no code change)
  - This is an operational fix: the `POST /predict/price-regime` route is already correctly defined in `server.py`; the running process simply predates the route registration
  - Document the restart command: `docker-compose restart ml-service` (or `docker-compose up -d ml-service` if using compose)
  - Alternatively, if running outside Docker: stop the uvicorn process and restart with `uvicorn src.server:app --host 0.0.0.0 --port 8100`
  - After restart, verify registration with: `curl -s http://localhost:8100/openapi.json | python -m json.tool | grep "price-regime"` — should output the route path
  - Acceptance check: `curl -s -X POST http://localhost:8100/predict/price-regime -H "Content-Type: application/json" -d '{"last_60_bars": []}' | jq .regime` → should return `"flat"`, `"bull"`, or `"bear"` (heuristic fallback for empty input)
  - _Bug_Condition: isBugCondition_2a(serviceState) where "/predict/price-regime" NOT IN registeredRoutes(serviceState)_
  - _Expected_Behavior: POST /predict/price-regime returns HTTP 200 after service restart_
  - _Requirements: 2.2, 3.2_

- [x] 5. Fix Bug 2b — Add optional-chain guards for `priceForecast` access in `india-builder.ts`

  - [x] 5.1 Audit all `priceForecast` accesses in `src/features/ai-signals/india-builder.ts` and `src/lib/india/ml-enhanced-context.ts`
    - Search for every occurrence of `mlCtxResult.priceForecast` (without `?.`) in both files
    - For each unsafe access, replace with `mlCtxResult?.priceForecast?.regime` (or the appropriate sub-property)
    - Pattern to find: `mlCtxResult\.priceForecast` (without preceding `?`)
    - Pattern to replace with: `mlCtxResult?.priceForecast` (add `?.` between object and property)
    - Existing safe accesses (`mlCtxResult?.rankings`, `mlCtxResult?.mlAvailable`) must remain unchanged
    - _Bug_Condition: isBugCondition_2b(mlCtxResult) where mlCtxResult IS null AND callerAccessesPropertyOf(mlCtxResult) WITHOUT null-check_
    - _Expected_Behavior: When mlCtxResult is null, all property accesses resolve to undefined without throwing TypeError_
    - _Preservation: When mlCtxResult is a valid MLEnhancedContext, behavior (blended regime score, ML rank boosts, signals) is identical to before_
    - _Requirements: 2.3, 3.2, 3.3_

  - [x] 5.2 Verify Bug 2b exploration test now passes
    - **Property 1: Expected Behavior** - Null mlCtxResult Handled Defensively
    - **IMPORTANT**: Re-run the SAME test from task 1 (india-builder-null-guard.test.ts) — do NOT write a new test
    - Run: `npx vitest run tests/features/india/india-builder-null-guard.test.ts`
    - **EXPECTED OUTCOME: Test PASSES** (confirms no TypeError on null mlCtxResult)
    - _Requirements: 2.3_

  - [x] 5.3 Verify Bug 2 preservation tests still pass
    - **Property 2: Preservation** - Non-null mlCtxResult Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME preservation tests from task 2
    - Run: `npx vitest run tests/features/india/india-builder-null-guard.test.ts`
    - **EXPECTED OUTCOME: Tests PASS** (confirms non-null path is unaffected)

- [x] 6. Fix Bug 3 — Add `KNOWN_DELISTED` denylist and early-return guard in `src/services/india/yahoo/index.ts`

  - [x] 6.1 Add `KNOWN_DELISTED` constant and early-return guard
    - Add at module level (above the class definition): `const KNOWN_DELISTED = new Set<string>(["TATAMOTORS"]);`
    - Add the comment: `// TATAMOTORS.NS is not recognised by Yahoo Finance (stock renamed); silence permanently`
    - At the very top of `getHistorical(req: HistoricalRequest)`, before the cache lookup: `if (KNOWN_DELISTED.has(req.symbol)) return [];`
    - This placement ensures no `yf.chart` call is made and no `console.error` is emitted for denylist symbols
    - No other changes to `YahooAdapter` — existing cache, retry, and error-logging logic is unchanged
    - _Bug_Condition: isBugCondition_3(symbol) where symbol IN KNOWN_DELISTED (currently: {"TATAMOTORS"})_
    - _Expected_Behavior: getHistorical returns [] immediately without logging when symbol is in KNOWN_DELISTED_
    - _Preservation: All symbols NOT in KNOWN_DELISTED behave identically — including console.error on genuine transient failures_
    - _Requirements: 2.4, 3.4, 3.5_

  - [x] 6.2 Verify Bug 3 exploration test now passes (fix-checking)
    - **Property 1: Expected Behavior** - KNOWN_DELISTED Symbol Returns Silently
    - **IMPORTANT**: Re-run the SAME test from task 1 (yahoo-denylist.test.ts) — but now assert `console.error` was NOT called
    - The task 1 test for Bug 3 confirmed `console.error` WAS called (documenting the bug). The fix-checking assertion is `callCount === 0`
    - Update the fix-checking assertion in the test: `expect(consoleSpy).not.toHaveBeenCalled()`
    - Run: `npx vitest run tests/services/india/yahoo-denylist.test.ts`
    - **EXPECTED OUTCOME: Test PASSES** (confirms TATAMOTORS returns [] silently)
    - _Requirements: 2.4_

  - [x] 6.3 Verify Bug 3 preservation tests still pass
    - **Property 2: Preservation** - Valid Symbol and Transient Error Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME preservation tests from task 2
    - Run: `npx vitest run tests/services/india/yahoo-denylist.test.ts`
    - **EXPECTED OUTCOME: Tests PASS** (confirms RELIANCE/INFY still work; non-denylist errors still log)

- [x] 7. Checkpoint — Ensure all tests pass
  - Run the full Python test suite: `cd ml-service && python -m pytest tests/ -v`
  - Run the full TypeScript test suite: `npx vitest run`
  - Confirm no regressions across all previously-passing tests
  - Confirm the three new test files all pass:
    - `ml-service/tests/test_schemas_optional.py` (Hypothesis property test — Bug 1)
    - `tests/services/india/yahoo-denylist.test.ts` (Vitest — Bug 3)
    - `tests/features/india/india-builder-null-guard.test.ts` (Vitest — Bug 2b)
  - Confirm Bug 2a operational fix: ML service is running and `POST /predict/price-regime` returns 200
  - Ask the user if any questions arise about edge cases or additional denylist entries
