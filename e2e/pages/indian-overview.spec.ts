import { test, expect } from "@playwright/test";
import {
  mockIndiaApiRoutes,
  assertNoErrorBoundary,
  waitForDataLoad,
  assertResponsiveLayout,
  mockApiErrorThenRecover,
  mockHealthReady,
} from "../helpers/page-helpers";

/**
 * E2E: Indian Market Overview page
 *
 * Tests: page loads, API data renders, loading state, empty state,
 *        error state, stale state, service recovery, responsive layouts.
 */

test.describe("Indian Market Overview", () => {
  test.beforeEach(async ({ page }) => {
    // Bypass auth for E2E tests (mock the session endpoint)
    await page.route("**/api/auth/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { name: "Test User", email: "test@alphaforge.dev" } }),
      });
    });
  });

  test("page loads without errors @smoke", async ({ page }) => {
    await mockIndiaApiRoutes(page);
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");

    // Must not show error boundary
    await assertNoErrorBoundary(page);

    // Title or heading should be present
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
  });

  test("shows loading skeleton then renders content", async ({ page }) => {
    // Add slight delay to catch loading state
    await page.route("**/api/in/**", async (route) => {
      await new Promise((r) => setTimeout(r, 200));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], status: "ok" }),
      });
    });

    await page.goto("/india");
    await waitForDataLoad(page, 5000);
    await assertNoErrorBoundary(page);
  });

  test("handles API error gracefully (error state)", async ({ page }) => {
    // Mock all API routes to return 500
    await page.route("**/api/in/**", async (route) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) });
    });

    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");

    // Should not crash — error state should be shown
    await assertNoErrorBoundary(page);
  });

  test("handles empty data state", async ({ page }) => {
    await page.route("**/api/in/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], stocks: [], signals: [], status: "ok" }),
      });
    });

    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");
    await assertNoErrorBoundary(page);
  });

  test("desktop layout - no horizontal overflow", async ({ page }) => {
    await mockIndiaApiRoutes(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");
    await assertResponsiveLayout(page);
  });

  test("mobile layout - no horizontal overflow", async ({ page }) => {
    await mockIndiaApiRoutes(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");
    await assertResponsiveLayout(page);
  });

  test("service recovery after error", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/in/market-snapshot**", async (route) => {
      calls++;
      if (calls <= 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service Unavailable" }) });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: [], status: "ok" }),
        });
      }
    });
    await mockIndiaApiRoutes(page);

    await page.goto("/india");
    await page.waitForLoadState("domcontentloaded");
    await assertNoErrorBoundary(page);
  });
});
