import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Test-only env defaults.
 *
 * Setting these on `test.env` below propagates them into every worker VM
 * BEFORE the test files (and their transitively-imported modules like
 * `src/lib/env.ts`) start evaluating. Setting them on the parent `process.env`
 * isn't enough with `pool: "vmThreads"` because each VM gets a fresh
 * `process.env` snapshot.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  AUTH_SECRET: "test-auth-secret-123456789012345678901234",
  AUTH_TRUST_HOST: "true",
  // 64 hex chars = 32 bytes (matches AES-256 key requirement in lib/crypto.ts).
  ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  DATABASE_URL: "postgresql://test:test@localhost:5432/alphaforge_test",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
};

// Mirror onto the parent process so any setup-time imports that pre-empt
// `test.env` (e.g. inside the Vite plugin pipeline) still see the values.
for (const [k, v] of Object.entries(TEST_ENV)) {
  process.env[k] ??= v;
}

/**
 * Vitest configuration for Alphaforge.
 *
 * Layered test layout (one folder per "level" so the per-level npm scripts in
 * package.json — `test:lib`, `test:features`, `test:components`, `test:api`,
 * `test:services`, `test:hooks`, `test:stores`, `test:pages` — can each
 * target a slice of the suite via `--dir`):
 *
 *   tests/lib/        Pure utilities (cn, formatPrice, market-mode, …)
 *   tests/features/   Business logic engines (best-time, sentiment,
 *                     strategy-lab parser, strategy-score, …)
 *   tests/components/ React components (UI primitives + smoke renders)
 *   tests/api/        Next.js Route Handlers (POST/GET handler tests)
 *   tests/services/   Service layer (broker shared helpers, cache backends)
 *   tests/hooks/      React hook tests
 *   tests/stores/     Zustand store tests
 *   tests/pages/      Page-component smoke tests
 *
 * Aliases for `@/*` are wired to `./src/*` so test imports look identical
 * to runtime imports.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Worker modules use `@worker/...` aliases so tests can mirror the
      // runtime import shape. Mirrors the entry in `worker/tsconfig.json`.
      "@worker": path.resolve(__dirname, "./worker/src"),
      // server-only is a runtime guard. In Node test env we replace it with
      // an empty module so files annotated with `import "server-only"`
      // (e.g. `lib/auth`, `lib/crypto`, `lib/prisma`) can still be
      // imported by unit tests.
      "server-only": path.resolve(__dirname, "./tests/setup/server-only-shim.ts"),
      // next/link drags in the app-router context which isn't available in
      // a pure jsdom test. Replace it with a minimal `<a>` shim so component
      // tests can render anchors without bootstrapping Next's runtime.
      "next/link": path.resolve(__dirname, "./tests/setup/next-link-shim.tsx"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup/vitest.setup.ts"],
    env: TEST_ENV,
    css: false,
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    // We deliberately do NOT exclude `worker/` here — its source modules
    // are imported by `tests/worker/**` via the `@worker` alias above.
    exclude: ["node_modules", ".next", "tests/setup/**"],
    // Vitest 4 has a known regression on Windows + Node 22+ where the default
    // `forks` pool reports "Vitest failed to find the current suite" when
    // hooks (`afterEach`) are registered inside `setupFiles`. Switching to
    // `vmThreads` is the upstream-recommended workaround. See
    // https://github.com/vitest-dev/vitest/issues/9384.
    pool: "vmThreads",
    server: {
      deps: {
        // Force these packages to be transformed by Vite (rather than the
        // node native loader) so JSX / TS works inside dynamic imports.
        inline: [
          "next",
          "next-auth",
          "@radix-ui/react-slot",
          "@radix-ui/react-tooltip",
        ],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}", "worker/src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/app/**/layout.tsx",
        "src/app/**/not-found.tsx",
        "src/types/**",
        "src/proxy.ts",
        "src/services/binance/liquidation-ws.ts",
        "src/services/brokers/**/ws.ts",
        // Worker entrypoint + IO-only modules are excluded — they wire up
        // long-running processes (signals, prisma, redis, websockets) that
        // are not meaningfully unit-testable. Their public surfaces are
        // covered by the per-module tests under `tests/worker/`.
        "worker/src/index.ts",
        "worker/src/db.ts",
        "worker/src/jobs/**",
      ],
    },
  },
});
