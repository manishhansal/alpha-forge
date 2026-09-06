// Next.js 16 renamed `middleware.ts` to `proxy.ts` (Node runtime only).
//
// BUG FIX (proxy-auth-csrf-crash-fix): Auth.js v5 beta.32 calls
// createCSRFToken → createHash → crypto.subtle.digest() on EVERY request
// that passes through auth(). In the Next.js 16 Turbopack proxy runtime,
// `crypto` is undefined when that call fires, causing:
//
//   [auth][error] TypeError: Cannot read properties of undefined (reading 'digest')
//
// This closes the TCP connection before any HTTP response is sent —
// which the browser sees as "Failed to fetch" for every /api/in/* route.
//
// Fix: short-circuit ALL public paths before delegating to auth(). Public
// paths (defined in src/lib/auth.ts) never need session data. For those
// routes we return NextResponse.next() immediately, skipping the CSRF token
// creation that triggers the crypto error. Protected routes still go through
// auth() so session-based redirects continue to work correctly.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth, isPublicPath } from "@/lib/auth";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Fast path: public routes never need session data and must not trigger
  // Auth.js's CSRF flow (which crashes in the Next.js 16 Turbopack proxy runtime).
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Protected routes: delegate to Auth.js so it can verify the JWT and
  // redirect unauthenticated users to /login.
  // The double cast via `unknown` is required because Auth.js types
  // `auth()` as accepting `NextAuthRequest` (an augmented NextRequest),
  // while the proxy runtime supplies a plain `NextRequest`. The shapes
  // are structurally compatible at runtime.
  return (auth as unknown as (req: NextRequest) => Promise<NextResponse>)(request);
}

export const config = {
  // Run the proxy on everything except Auth.js's own callback routes, Next.js
  // internals, and static assets. The authorized callback in src/lib/auth.ts
  // decides which of the remaining routes actually require a session.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
