/**
 * Global Vitest setup for the Alphaforge test suite.
 *
 * Loaded via `setupFiles` in `vitest.config.ts`. Vitest invokes this once
 * per worker, after the test environment (jsdom) has booted. Hooks like
 * `afterEach` registered here apply to every test in the worker.
 */
import "@testing-library/jest-dom/vitest";

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Required env so `src/lib/env.ts` zod parse passes. Non-secret defaults that
// only matter for the test environment.
process.env.NODE_ENV ??= "test";
process.env.AUTH_SECRET ??= "test-auth-secret-123456789012345678901234";
process.env.AUTH_TRUST_HOST ??= "true";
// 64 hex chars = 32 bytes (matches AES-256 key requirement in lib/crypto.ts).
process.env.ENCRYPTION_KEY ??=
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
process.env.DATABASE_URL ??=
  "postgresql://test:test@localhost:5432/alphaforge_test";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

afterEach(() => {
  cleanup();
});

// next/navigation is a client-only module that throws outside of Next's
// runtime. Provide a thin mock so components which call `usePathname()` /
// `useRouter()` can be rendered inside Vitest.
vi.mock("next/navigation", () => {
  const pathname = { current: "/" };
  return {
    usePathname: () => pathname.current,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
    redirect: (url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    },
    permanentRedirect: (url: string) => {
      throw new Error(`NEXT_PERMANENT_REDIRECT:${url}`);
    },
    notFound: () => {
      throw new Error("NEXT_NOT_FOUND");
    },
    __setPathname: (p: string) => {
      pathname.current = p;
    },
  };
});

// next/headers — keep a no-op so server actions / route handlers that touch
// cookies / headers don't crash in unit tests.
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: vi.fn(),
    getAll: vi.fn(() => []),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: () => new Map(),
}));

// `next/link` is replaced via `resolve.alias` in vitest.config.ts. See
// `tests/setup/next-link-shim.tsx` — using an alias is more reliable than a
// `vi.mock` factory because it intercepts the import path before any module
// resolves the real `next/link`.
