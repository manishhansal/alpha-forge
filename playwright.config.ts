import { defineConfig, devices } from "@playwright/test";

/**
 * AlphaForge Playwright E2E Configuration
 *
 * Tests run against a live Next.js development server on localhost:3000.
 * For CI/integration runs the server should already be started (webServer
 * will spin up a local dev server automatically if not available).
 *
 * Usage:
 *   npx playwright test                        # all E2E tests
 *   npx playwright test --grep @smoke          # smoke tests only
 *   npx playwright test --project=mobile       # mobile viewport
 *   npx playwright test e2e/indian-overview    # single page
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: !CI,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 2 : undefined,

  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "playwright-results.json" }],
  ],

  use: {
    baseURL: BASE_URL,
    // Capture on failure
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Realistic browser settings
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "desktop-chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "mobile-chrome",
      use: {
        ...devices["Pixel 5"],
      },
    },
  ],

  // Auto-start dev server when not already running
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      // Stub auth and disable live broker for E2E
      NEXT_PUBLIC_APP_URL: BASE_URL,
      ML_MODE: "disabled",
      LIVE_TRADING_ENABLED: "",
    },
  },
});
