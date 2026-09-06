# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Public Path Triggers Auth.js CSRF Crash
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the crash on unfixed code
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases: `/api/in/nifty-bias`, `/api/in/msb-signals`, `/api/in/market-snapshot` with `crypto = undefined`
  - Mock `crypto` as `undefined` to simulate the Next.js 16 Turbopack proxy runtime
  - Call the proxy handler (the current `auth` re-export) with a `NextRequest` for each public `/api/in/*` path
  - Assert that the handler returns a valid `NextResponse` with no crash (from Bug Condition in design: `isBugCondition` holds when `isPublicPath` returns `true` and `auth()` is called)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS with `TypeError: Cannot read properties of undefined (reading 'digest')` — this proves the bug exists
  - Document counterexamples found: e.g. `proxy(GET /api/in/nifty-bias)` throws `TypeError` instead of returning `NextResponse.next()`
  - Mark task complete when test is written, run, and the `TypeError` failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Protected Route Auth Delegation
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `proxy(GET /in/paper-trading)` with no session token on UNFIXED code produces a redirect to `/login`
  - Observe: `proxy(GET /in/paper-trading)` with a valid JWT on UNFIXED code passes through without redirect
  - Write property-based tests: for all pathnames where `isPublicPath` returns `false`, the proxy delegates to `auth()` and produces a redirect (no session) or pass-through (valid session) — from Preservation Requirements in design
  - Verify tests PASS on UNFIXED code (baseline confirmed)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS — this confirms the baseline protected-route behavior to preserve
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2_

- [x] 3. Fix for unconditional auth() invocation on public paths

  - [x] 3.1 Rewrite src/proxy.ts with public-path short-circuit
    - Remove `export { auth as proxy }` re-export
    - Add `import { NextResponse } from "next/server"` and `import type { NextRequest } from "next/server"`
    - Add `import { auth, isPublicPath } from "@/lib/auth"` (both from same module)
    - Export `async function proxy(request: NextRequest)` that:
      - Returns `NextResponse.next()` immediately when `isPublicPath(request.nextUrl.pathname)` is `true`
      - Calls and returns `auth(request as Parameters<typeof auth>[0])` when `false`
    - Keep the `config.matcher` array unchanged
    - _Bug_Condition: isBugCondition(request) where isPublicPath(request.nextUrl.pathname) = true AND auth() is invoked_
    - _Expected_Behavior: proxy_fixed(request) returns NextResponse.next() without calling auth() for all public paths_
    - _Preservation: Protected routes (isPublicPath = false) still delegate to auth() for redirect/pass-through_
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Public Path Short-Circuit
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior: public-path requests return `NextResponse.next()` without crashing
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES — confirms the CSRF crash is eliminated for public paths
    - _Requirements: 2.1_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Protected Route Auth Delegation
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS — confirms no regressions in protected-route redirect behavior
    - Confirm authenticated users still reach protected routes and unauthenticated users are still redirected

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `npx vitest run` and verify all tests pass (expected: 3059/3059) — RESULT: 3090/3090 (31 new tests added)
  - Confirm no TypeScript errors (`npx tsc --noEmit`) — RESULT: 0 errors
  - Ensure all tests pass; ask the user if any questions arise
