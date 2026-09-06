# Bugfix Requirements Document

## Introduction

Auth.js v5 (next-auth@5.0.0-beta.32) calls `createCSRFToken → createHash → crypto.subtle.digest()` on every request that passes through the `auth()` handler. In the Next.js 16 Turbopack proxy runtime, `crypto` is `undefined` at the time that call fires, causing an unhandled `TypeError` that closes the connection before any response is sent. This manifests as `Failed to fetch` in the browser for all routes handled by `src/proxy.ts`, including the fully public `/api/in/*` endpoints (`/api/in/msb-signals`, `/api/in/nifty-bias`, `/api/in/market-snapshot`) that should never require session data.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a request is made to any route matched by `proxy.ts` (including public routes such as `/api/in/msb-signals`, `/api/in/nifty-bias`, and `/api/in/market-snapshot`) THEN the system unconditionally delegates to `auth()`, which calls `createCSRFToken → createHash → crypto.subtle.digest()` and crashes with `TypeError: Cannot read properties of undefined (reading 'digest')`

1.2 WHEN the `TypeError` is thrown inside Auth.js's `createHash` THEN the system closes the connection without sending any HTTP response, causing the browser to report `Failed to fetch`

### Expected Behavior (Correct)

2.1 WHEN a request pathname matches `isPublicPath()` (e.g. `/api/in/msb-signals`, `/api/in/nifty-bias`, `/api/in/market-snapshot`) THEN the system SHALL return `NextResponse.next()` immediately, without invoking `auth()` or triggering the CSRF token creation flow

2.2 WHEN a request pathname does NOT match `isPublicPath()` (i.e. a protected route such as `/in/paper-trading`) THEN the system SHALL delegate to the `auth()` handler so that unauthenticated users are redirected to `/login`

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an unauthenticated user requests a protected route (e.g. `/in/paper-trading`) THEN the system SHALL CONTINUE TO redirect them to `/login`

3.2 WHEN an authenticated user requests a protected route THEN the system SHALL CONTINUE TO allow the request to proceed without redirection

3.3 WHEN a request is made to any public page path (e.g. `/`, `/heatmap`, `/login`, `/signup`) THEN the system SHALL CONTINUE TO serve the page without requiring authentication

3.4 WHEN a request is made to other public API prefixes (e.g. `/api/market`, `/api/sentiment`, `/api/signals`, `/api/futures/tickers`) THEN the system SHALL CONTINUE TO return successful responses without authentication
