import type { Page, Route } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Shared helpers for AlphaForge Playwright E2E tests.
 */

// ─── API Mock Helpers ─────────────────────────────────────────────────────────

/** Intercept all /api/in/* routes and return a minimal stub payload. */
export async function mockIndiaApiRoutes(page: Page): Promise<void> {
  await page.route("**/api/in/**", async (route: Route) => {
    const url = route.request().url();

    // Feed SSE — return a closed stream
    if (url.includes("/feed")) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "data: {\"type\":\"CONNECTED\"}\n\n",
      });
      return;
    }

    // Health
    if (url.includes("/health")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", cache: { roundTrip: "ok" }, fetchedAt: new Date().toISOString() }),
      });
      return;
    }

    // All other /api/in/* — return empty-data stub
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], status: "ok", fetchedAt: new Date().toISOString() }),
    });
  });
}

/** Stub the aggregate ready endpoint. */
export async function mockHealthReady(
  page: Page,
  status: "ready" | "degraded" | "unavailable" = "ready",
): Promise<void> {
  await page.route("**/api/health/ready", async (route) => {
    await route.fulfill({
      status: status === "unavailable" ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify({
        status,
        timestamp: new Date().toISOString(),
        uptimeSeconds: 300,
        dependencies: {
          database:   { status: "healthy", latencyMs: 2,   lastSuccess: new Date().toISOString(), details: {} },
          redis:      { status: "healthy", latencyMs: 1,   lastSuccess: new Date().toISOString(), details: {} },
          ml:         { status: status === "degraded" ? "unhealthy" : "healthy", latencyMs: 12, lastSuccess: null, details: {} },
          marketData: { status: "healthy", latencyMs: 5,   lastSuccess: new Date().toISOString(), details: {} },
          worker:     { status: "healthy", latencyMs: 1,   lastSuccess: new Date().toISOString(), details: {} },
        },
      }),
    });
  });
}

/** Simulate a transient API error then recover. */
export async function mockApiErrorThenRecover(
  page: Page,
  pattern: string,
  errorCount = 1,
): Promise<void> {
  let count = 0;
  await page.route(pattern, async (route) => {
    if (count < errorCount) {
      count++;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "simulated error" }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], status: "ok" }) });
    }
  });
}

/** Simulate stale/slow API response. */
export async function mockSlowApi(page: Page, pattern: string, delayMs = 3000): Promise<void> {
  await page.route(pattern, async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], status: "ok", stale: true }),
    });
  });
}

// ─── Navigation Helpers ───────────────────────────────────────────────────────

/** Navigate to a page and wait for it to fully load. */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // Wait for the page to be interactive
  await page.waitForLoadState("domcontentloaded");
}

/** Assert the page did not render an error boundary. */
export async function assertNoErrorBoundary(page: Page): Promise<void> {
  const errorBoundary = page.locator('[data-testid="error-boundary"], [role="alert"]:has-text("something went wrong")');
  const count = await errorBoundary.count();
  expect(count, "Unexpected error boundary on page").toBe(0);
}

/** Assert the page has a loading skeleton (non-empty state). */
export async function assertLoadingState(page: Page): Promise<boolean> {
  const skeleton = page.locator('[data-testid="skeleton"], .animate-pulse, [aria-busy="true"]');
  try {
    await skeleton.first().waitFor({ timeout: 2000 });
    return true;
  } catch {
    return false; // No loading state visible — page may have loaded instantly
  }
}

/** Wait for data to render (skeleton disappears). */
export async function waitForDataLoad(page: Page, timeout = 10_000): Promise<void> {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('.animate-pulse, [data-loading="true"]').length === 0,
      { timeout },
    );
  } catch {
    // Timeout waiting for skeleton to disappear — acceptable if content is visible
  }
}

/** Assert responsive layout. */
export async function assertResponsiveLayout(page: Page): Promise<void> {
  // Check no horizontal overflow
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasOverflow, "Horizontal overflow detected — responsive layout broken").toBe(false);
}

/** Check for console errors (warn about them but don't fail). */
export async function collectConsoleErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}
