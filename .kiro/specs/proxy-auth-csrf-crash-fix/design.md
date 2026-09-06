# proxy-auth-csrf-crash-fix Bugfix Design

## Overview

`src/proxy.ts` currently exports `auth` from `next-auth` directly as the proxy handler (`export { auth as proxy }`). Auth.js v5 beta calls `createCSRFToken → createHash → crypto.subtle.digest()` on **every** request, including fully public routes. In the Next.js 16 Turbopack proxy runtime, `crypto` is `undefined` when that call fires, causing an unhandled `TypeError` that closes the TCP connection before any HTTP response is written. The browser sees this as `Failed to fetch`.

The fix is minimal: introduce an explicit `proxy` function that checks `isPublicPath(pathname)` before touching `auth()`. Public routes get `NextResponse.next()` immediately; protected routes continue to delegate to `auth()`.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the crash — `auth()` is invoked for a public-path request, causing `createCSRFToken → crypto.subtle.digest()` to run where `crypto` is `undefined`
- **Property (P)**: The desired behavior when the bug condition holds — the proxy returns `NextResponse.next()` immediately without calling `auth()`
- **Preservation**: The existing redirect-to-login behavior for protected routes, and the pass-through for all other public routes, must remain unchanged by the fix
- **`isPublicPath`**: Exported function in `src/lib/auth.ts` that returns `true` for `/_next*`, all `PUBLIC_API_PREFIXES`, and all `PUBLIC_PAGE_PATHS`
- **`auth`**: The Auth.js v5 handler exported from `src/lib/auth.ts` — internally calls `createCSRFToken` on every invocation in beta.32
- **`proxy`**: The Next.js 16 proxy entrypoint (equivalent of `middleware` in earlier versions), defined in `src/proxy.ts`

## Bug Details

### Bug Condition

The bug manifests on every request whose pathname matches `isPublicPath()` — specifically `/api/in/*` routes — because `proxy.ts` invokes `auth()` unconditionally. The `auth()` call triggers `createCSRFToken`, which calls `crypto.subtle.digest()`. In the Next.js 16 Turbopack proxy runtime, `crypto` is `undefined` at that point.

**Formal Specification:**
```
FUNCTION isBugCondition(request)
  INPUT: request of type NextRequest
  OUTPUT: boolean

  RETURN isPublicPath(request.nextUrl.pathname)
         AND auth() is called for this request
         AND crypto.subtle is undefined in the current runtime context
END FUNCTION
```

### Examples

- `GET /api/in/nifty-bias` → `auth()` called → `createCSRFToken` → `crypto.subtle.digest()` → `TypeError: Cannot read properties of undefined (reading 'digest')` → connection closed → browser: `Failed to fetch`
- `GET /api/in/msb-signals` → same crash path
- `GET /api/in/market-snapshot` → same crash path
- `GET /api/market` → same crash path (also a public API prefix)
- `GET /login` → same crash path (also a public page)
- `GET /in/paper-trading` (protected) → `auth()` is legitimately needed; this path does NOT satisfy the bug condition in the fixed code

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Unauthenticated requests to protected routes (e.g. `/in/paper-trading`, `/in/alerts`) must still be redirected to `/login`
- Authenticated requests to protected routes must still pass through without redirection
- All currently-public page paths (`/`, `/heatmap`, `/in/dashboard`, `/login`, `/signup`, etc.) must continue to be served without authentication
- All currently-public API prefixes (`/api/market`, `/api/sentiment`, `/api/signals`, `/api/futures/tickers`, `/api/in`) must continue to return responses without authentication
- The `matcher` config in `proxy.ts` must remain unchanged so the proxy continues to run on the same set of routes

**Scope:**
All requests where `isPublicPath(pathname)` returns `true` are affected by the bug and are the target of the fix. All requests where `isPublicPath(pathname)` returns `false` (protected routes) must be completely unaffected — they still go through `auth()` exactly as before.

## Hypothesized Root Cause

1. **Unconditional `auth()` delegation**: `export { auth as proxy }` passes every matched request directly to Auth.js with no pre-check, so `createCSRFToken` always fires regardless of whether the route needs session data.

2. **`crypto.subtle` unavailability in Turbopack proxy runtime**: Next.js 16's Turbopack-compiled proxy/middleware runtime does not polyfill or expose the Web Crypto API at the time Auth.js's `createHash` runs. This is a known beta incompatibility between `next-auth@5.0.0-beta.32` and Next.js 16 Turbopack.

3. **CSRF token creation is eager**: Auth.js v5 beta calls `createCSRFToken` during `init()` on every request entry, even when the `authorized` callback would immediately return `true` — there is no lazy or conditional path.

## Correctness Properties

Property 1: Bug Condition - Public Path Short-Circuit

_For any_ request where `isPublicPath(request.nextUrl.pathname)` returns `true`, the fixed `proxy` function SHALL return `NextResponse.next()` immediately without invoking `auth()`, thereby avoiding the `createCSRFToken → crypto.subtle.digest()` call chain that causes the `TypeError`.

**Validates: Requirements 2.1**

Property 2: Preservation - Protected Route Auth Delegation

_For any_ request where `isPublicPath(request.nextUrl.pathname)` returns `false`, the fixed `proxy` function SHALL delegate to `auth()` and produce the same outcome as the original code — redirecting unauthenticated users to `/login` and passing authenticated users through.

**Validates: Requirements 3.1, 3.2**

## Fix Implementation

### Changes Required

**File**: `src/proxy.ts`

**Change**: Replace the re-export shorthand with an explicit async `proxy` function.

**Specific Changes**:

1. **Remove direct re-export**: Delete `export { auth as proxy }` — this is the root of the unconditional `auth()` invocation.

2. **Import `NextResponse` and `NextRequest`**: Add `import { NextResponse } from "next/server"` and `import type { NextRequest } from "next/server"` for the fast-path return.

3. **Import `isPublicPath`**: Add `import { isPublicPath } from "@/lib/auth"` alongside the existing `auth` import (both from `@/lib/auth`).

4. **Add explicit `proxy` function**: Export `async function proxy(request: NextRequest)` that:
   - Calls `isPublicPath(request.nextUrl.pathname)` first
   - Returns `NextResponse.next()` if `true`
   - Calls and returns `auth(request as Parameters<typeof auth>[0])` if `false`

5. **Verify `isPublicPath` export**: Confirm `isPublicPath` is already exported from `src/lib/auth.ts` (it is — the `export function isPublicPath` declaration exists). No change needed there.

6. **Keep `config` unchanged**: The `matcher` array stays identical.

## Testing Strategy

### Validation Approach

The testing strategy follows two phases: first, surface counterexamples on unfixed code to confirm the crash exists and understand which paths are affected; then verify the fix resolves the crash for public paths while preserving redirect behavior for protected paths.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the crash BEFORE implementing the fix. Confirm that calling `auth()` on a public-path request causes the `TypeError` in the test environment.

**Test Plan**: Write a test that mocks `crypto` as `undefined` (simulating the Turbopack proxy runtime) and invokes the proxy handler with a public-path request (`/api/in/nifty-bias`). Assert the handler throws or that the response is not a valid HTTP response. Run on UNFIXED code to observe the failure.

**Test Cases**:
1. **Public API path crash test**: Call proxy with `GET /api/in/nifty-bias`, `crypto = undefined` → expect crash/no valid response (will fail on unfixed code)
2. **Public page path crash test**: Call proxy with `GET /login`, `crypto = undefined` → expect crash/no valid response (will fail on unfixed code)
3. **Root path crash test**: Call proxy with `GET /`, `crypto = undefined` → expect crash/no valid response (will fail on unfixed code)

**Expected Counterexamples**:
- Proxy handler throws `TypeError: Cannot read properties of undefined (reading 'digest')` for any public-path request
- No HTTP response object is returned; connection is effectively closed

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed proxy returns `NextResponse.next()` without calling `auth()`.

**Pseudocode:**
```
FOR ALL request WHERE isBugCondition(request) DO
  result := proxy_fixed(request)
  ASSERT result instanceof NextResponse
  ASSERT auth was NOT called
  ASSERT result is "next" (pass-through, no redirect)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all requests where `isPublicPath` returns `false`, the fixed proxy delegates to `auth()` and produces the same outcome as the original.

**Pseudocode:**
```
FOR ALL request WHERE NOT isBugCondition(request) DO
  ASSERT proxy_original(request) produces same redirect/pass-through as proxy_fixed(request)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because it can generate many combinations of protected pathnames (with and without a valid session token) and verify that the auth delegation behavior is identical before and after the fix.

**Test Cases**:
1. **Protected route unauthenticated**: `GET /in/paper-trading` with no session → must redirect to `/login`
2. **Protected route authenticated**: `GET /in/paper-trading` with valid JWT → must pass through
3. **Protected nested route**: `GET /in/alerts/new` with no session → must redirect to `/login`

### Unit Tests

- Test `isPublicPath` is called with the correct `pathname` from `request.nextUrl`
- Test that `auth()` is never called when `isPublicPath` returns `true`
- Test that `auth()` is always called when `isPublicPath` returns `false`
- Test edge cases: root path `/`, paths with trailing slashes, paths just outside the public prefix boundary

### Property-Based Tests

- Generate random pathnames known to satisfy `isPublicPath` → assert `auth` is not called and response is `NextResponse.next()`
- Generate random pathnames known to NOT satisfy `isPublicPath` → assert `auth` is called exactly once
- Generate many variations of `/api/in/*` paths and verify all return pass-through without crashing

### Integration Tests

- Full proxy call with a real `NextRequest` for `/api/in/nifty-bias` → HTTP 200 (not "Failed to fetch")
- Full proxy call for `/in/paper-trading` without session → 302 redirect to `/login`
- Full proxy call for `/login` → HTTP 200, no redirect loop
