// Next.js 16 renamed `middleware.ts` to `proxy.ts` (Node runtime only).
// Auth.js v5's `auth()` export works as a request middleware: when the
// `authorized` callback (defined in `src/lib/auth.ts`) returns false for a
// protected route, Auth.js issues a redirect to the configured signIn page.
export { auth as proxy } from "@/lib/auth";

export const config = {
  // Run the proxy on everything except Auth.js's own callback routes, Next.js
  // internals, and static assets. The `authorized` callback in src/lib/auth.ts
  // decides which of the remaining routes actually require a session.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
