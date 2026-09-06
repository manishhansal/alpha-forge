/**
 * proxy-auth-csrf-crash-fix — Bug Condition & Preservation Tests
 *
 * Task 1 — Bug Condition Exploration (Property 1):
 *   Simulates the Next.js 16 Turbopack proxy runtime by mocking `auth` as a
 *   function that throws `TypeError: Cannot read properties of undefined
 *   (reading 'digest')` (the CSRF/crypto crash). On UNFIXED code (`export {
 *   auth as proxy }`) every public-path request passes through auth() and
 *   crashes. On FIXED code the proxy short-circuits with NextResponse.next()
 *   before ever calling auth(), so these tests PASS.
 *
 *   **EXPECTED OUTCOME on unfixed code**: FAILS with TypeError (bug confirmed)
 *   **EXPECTED OUTCOME on fixed code**:   PASSES (bug eliminated)
 *
 *   Validates: Requirements 1.1, 1.2, 2.1
 *
 * Task 2 — Preservation (Property 2):
 *   Verifies that protected routes still delegate to auth() for
 *   redirect/pass-through behavior. These tests PASS on both unfixed and fixed
 *   code (baseline confirmed, no regression).
 *
 *   Validates: Requirements 3.1, 3.2
 */

import { NextRequest } from "next/server";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock next/server so NextResponse.next() returns a trackable object.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    NextResponse: {
      ...actual.NextResponse,
      next: vi.fn(() => ({ type: "next" })),
      redirect: vi.fn((url: URL | string) => ({
        type: "redirect",
        url: url.toString(),
      })),
    },
  };
});

// Mock @/lib/auth — auth() is a function that throws the CSRF crypto crash
// (simulating the bug). After the fix, public paths never invoke it.
// For preservation tests, protected routes must still call auth().
vi.mock("@/lib/auth", async () => {
  const { isPublicPath: realIsPublicPath } = await import(
    "../../src/lib/auth"
  );

  const authMock = vi.fn(() => {
    throw new TypeError(
      "Cannot read properties of undefined (reading 'digest')",
    );
  });

  return {
    auth: authMock,
    isPublicPath: realIsPublicPath,
    // Expose handlers/signIn/signOut as stubs so the module shape matches.
    handlers: {},
    signIn: vi.fn(),
    signOut: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Import proxy AFTER mocks are registered so the mocked modules are resolved.
const { proxy } = await import("../../src/proxy");

// Grab auth mock reference for call-count assertions.
const { auth: authMock } = await import("../../src/lib/auth");
const { NextResponse } = await import("next/server");

// ============================================================================
// Task 1 — Bug Condition: Public Path Short-Circuit (Property 1)
//
// **Validates: Requirements 1.1, 1.2, 2.1**
//
// On UNFIXED code  → EXPECTED TO FAIL (TypeError confirms bug exists)
// On FIXED code    → EXPECTED TO PASS  (short-circuit eliminates crash)
// ============================================================================

describe("Property 1: Bug Condition — public paths must not call auth()", () => {
  beforeEach(() => {
    (authMock as Mock).mockClear();
    (NextResponse.next as Mock).mockClear();
  });

  const publicPaths = [
    "/api/in/nifty-bias",
    "/api/in/msb-signals",
    "/api/in/market-snapshot",
    "/api/market",
    "/api/sentiment",
    "/api/signals",
    "/api/futures/tickers",
    "/",
    "/heatmap",
    "/login",
    "/signup",
    "/in/dashboard",
    "/in/heatmap",
  ];

  for (const pathname of publicPaths) {
    it(`proxy(GET ${pathname}) returns NextResponse.next() without calling auth()`, async () => {
      const request = makeRequest(pathname);

      // On unfixed code this throws; on fixed code it returns normally.
      const response = await proxy(request);

      // auth() must NOT have been called for any public path.
      expect(authMock).not.toHaveBeenCalled();

      // The response must be the NextResponse.next() fast-path object.
      expect(NextResponse.next).toHaveBeenCalledOnce();
      expect(response).toEqual({ type: "next" });
    });
  }
});

// ============================================================================
// Task 2 — Preservation: Protected Route Auth Delegation (Property 2)
//
// **Validates: Requirements 3.1, 3.2**
//
// These tests confirm the baseline behavior is preserved on both unfixed and
// fixed code: protected routes always delegate to auth().
//
// For these tests we need auth() to NOT throw but instead simulate a redirect
// (unauthenticated) or pass-through (authenticated). We override the mock
// per-test below.
// ============================================================================

describe("Property 2: Preservation — protected routes delegate to auth()", () => {
  // These paths are NOT matched by isPublicPath() — isPublicPath returns false
  // for routes outside the public-page and public-API lists. Note: /in/*
  // sub-paths ARE public (the "/in" entry in PUBLIC_PAGE_PATHS matches them via
  // startsWith), so we use top-level protected routes like /scalper, /alerts.
  const protectedPaths = [
    "/scalper",
    "/strategies",
    "/charts",
    "/alerts",
    "/alerts/new",
    "/profile",
    "/settings",
    "/dashboard",
    "/watchlist",
  ];

  describe("unauthenticated requests are redirected to /login", () => {
    beforeEach(() => {
      (authMock as Mock).mockClear();
      (NextResponse.redirect as Mock).mockClear();
      // Simulate Auth.js redirecting to /login for unauthenticated users.
      (authMock as Mock).mockResolvedValue({
        type: "redirect",
        url: "http://localhost/login",
      });
    });

    for (const pathname of protectedPaths) {
      it(`proxy(GET ${pathname}) without session delegates to auth()`, async () => {
        const request = makeRequest(pathname);
        await proxy(request);

        // auth() MUST be called for protected routes.
        expect(authMock).toHaveBeenCalledOnce();
      });
    }
  });

  describe("authenticated requests pass through via auth()", () => {
    beforeEach(() => {
      (authMock as Mock).mockClear();
      (NextResponse.next as Mock).mockClear();
      // Simulate Auth.js passing through for authenticated users.
      (authMock as Mock).mockResolvedValue({ type: "next" });
    });

    for (const pathname of protectedPaths) {
      it(`proxy(GET ${pathname}) with valid session delegates to auth()`, async () => {
        const request = makeRequest(pathname);
        await proxy(request);

        // auth() MUST be called for protected routes.
        expect(authMock).toHaveBeenCalledOnce();
      });
    }
  });
});
