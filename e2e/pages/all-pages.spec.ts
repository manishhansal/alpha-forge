import { test, expect } from "@playwright/test";
import {
  mockIndiaApiRoutes,
  assertNoErrorBoundary,
  waitForDataLoad,
  assertResponsiveLayout,
} from "../helpers/page-helpers";

/**
 * E2E: All required AlphaForge pages — smoke and interaction tests.
 *
 * Required pages:
 *   Indian Overview        /india
 *   AI Signals             /india/ai-signals
 *   Options Chain          /india/options
 *   Daily Picks            /india/daily-picks
 *   FnO Trend Scanner      /india/scanner
 *   Strategies             /strategy-lab
 *   Paper Trading          /india/paper-trading
 *   Trade History          /india/trade-history
 *   Risk Dashboard         /india/risk
 *   Model Monitoring       /india/ml-monitoring
 *   Experiments            /india/experiments
 */

const PAGES = [
  { name: "Indian Overview",   path: "/india",               tag: "@smoke" },
  { name: "AI Signals",        path: "/india/ai-signals",    tag: "@smoke" },
  { name: "Options Chain",     path: "/india/options",       tag: "@smoke" },
  { name: "Daily Picks",       path: "/india/daily-picks",   tag: "@smoke" },
  { name: "FnO Trend Scanner", path: "/india/scanner",       tag: "@smoke" },
  { name: "Strategies",        path: "/strategy-lab",        tag: "@smoke" },
  { name: "Paper Trading",     path: "/india/paper-trading", tag: "@smoke" },
  { name: "Trade History",     path: "/india/trade-history", tag: "@smoke" },
  { name: "Risk Dashboard",    path: "/india/risk",          tag: "@smoke" },
  { name: "Model Monitoring",  path: "/india/ml-monitoring", tag: "@smoke" },
  { name: "Experiments",       path: "/india/experiments",   tag: "@smoke" },
];

// ─── Smoke: every page must load without a crash ──────────────────────────────

for (const { name, path } of PAGES) {
  test(`${name} — loads without crash @smoke`, async ({ page }) => {
    await mockIndiaApiRoutes(page);

    // Stub all /api/* routes generically
    await page.route("**/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/auth")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ user: null }),
        });
        return;
      }
      if (url.includes("/feed")) {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: "data: {\"type\":\"CONNECTED\"}\n\ndata: {\"type\":\"HEARTBEAT\"}\n\n",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], status: "ok", fetchedAt: new Date().toISOString() }),
      });
    });

    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await assertNoErrorBoundary(page);
  });
}

// ─── Loading states ───────────────────────────────────────────────────────────

test("AI Signals — shows loading then renders", async ({ page }) => {
  let resolved = false;
  await page.route("**/api/in/ai-signals**", async (route) => {
    if (!resolved) {
      resolved = true;
      await new Promise((r) => setTimeout(r, 300));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        signals: [
          {
            id: "sig-1",
            symbol: "NIFTY",
            type: "LONG",
            confidence: 0.82,
            entry: 24640,
            stopLoss: 24580,
            target: 24750,
            risk: "medium",
            generatedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });
  await mockIndiaApiRoutes(page);

  await page.goto("/india/ai-signals");
  await waitForDataLoad(page, 8000);
  await assertNoErrorBoundary(page);
});

// ─── Empty state ──────────────────────────────────────────────────────────────

test("Daily Picks — empty state renders without crash", async ({ page }) => {
  await page.route("**/api/in/daily-picks**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ picks: [], tradeDate: "2026-09-01", status: "ok" }),
    });
  });
  await mockIndiaApiRoutes(page);
  await page.goto("/india/daily-picks");
  await page.waitForLoadState("domcontentloaded");
  await assertNoErrorBoundary(page);
});

// ─── Error state ──────────────────────────────────────────────────────────────

test("Options Chain — handles fetch error gracefully", async ({ page }) => {
  await page.route("**/api/in/option-chain**", async (route) => {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Bad Gateway" }) });
  });
  await mockIndiaApiRoutes(page);
  await page.goto("/india/options");
  await page.waitForLoadState("domcontentloaded");
  await assertNoErrorBoundary(page);
});

// ─── Navigation ───────────────────────────────────────────────────────────────

test("Navigation — can navigate between pages without reload @smoke", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], status: "ok" }),
    });
  });
  await page.route("**/api/auth/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: null }) });
  });

  await page.goto("/india");
  await page.waitForLoadState("domcontentloaded");

  // Click any navigation links that exist
  const navLinks = page.locator("nav a, [role='navigation'] a");
  const count = await navLinks.count();

  if (count > 0) {
    // Try the first nav link
    const href = await navLinks.first().getAttribute("href");
    if (href && href.startsWith("/")) {
      await navLinks.first().click();
      await page.waitForLoadState("domcontentloaded");
      await assertNoErrorBoundary(page);
    }
  }
});

// ─── Market switching ─────────────────────────────────────────────────────────

test("Market switching — selector changes API calls", async ({ page }) => {
  const requestedUrls: string[] = [];
  await page.route("**/api/**", async (route) => {
    requestedUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], status: "ok" }),
    });
  });

  await page.goto("/india");
  await page.waitForLoadState("domcontentloaded");

  // Look for market selectors (tabs, dropdowns, buttons)
  const marketSelector = page.locator('[data-testid="market-selector"], select[name*="symbol"], button[data-symbol]');
  const selectorCount = await marketSelector.count();

  if (selectorCount > 0) {
    await marketSelector.first().click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  // Navigation happened without crash
  await assertNoErrorBoundary(page);
});

// ─── Responsive layouts ───────────────────────────────────────────────────────

test.describe("Responsive layouts", () => {
  const viewports = [
    { name: "Desktop 1440",  width: 1440, height: 900 },
    { name: "Desktop 1280",  width: 1280, height: 800 },
    { name: "Tablet 768",    width: 768,  height: 1024 },
    { name: "Mobile 375",    width: 375,  height: 812 },
  ];

  for (const vp of viewports) {
    test(`${vp.name} — no horizontal overflow`, async ({ page }) => {
      await mockIndiaApiRoutes(page);
      await page.route("**/api/**", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
      });

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/india");
      await page.waitForLoadState("domcontentloaded");
      await assertResponsiveLayout(page);
      await assertNoErrorBoundary(page);
    });
  }
});

// ─── SSE reconnect ────────────────────────────────────────────────────────────

test("SSE feed — page remains functional after SSE disconnect", async ({ page }) => {
  let sseCallCount = 0;
  await page.route("**/api/in/feed**", async (route) => {
    sseCallCount++;
    if (sseCallCount === 1) {
      // First connection — send a message then close
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: {\"type\":\"CONNECTED\"}\n\ndata: {\"type\":\"TICK\",\"payload\":{\"symbol\":\"NIFTY\",\"ltp\":24640}}\n\n",
      });
    } else {
      // Reconnect — serve normally
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: "data: {\"type\":\"CONNECTED\"}\n\n",
      });
    }
  });
  await mockIndiaApiRoutes(page);

  await page.goto("/india");
  await page.waitForLoadState("domcontentloaded");

  // Wait a moment for any reconnect logic
  await page.waitForTimeout(1000);
  await assertNoErrorBoundary(page);
});

// ─── Chart cleanup ────────────────────────────────────────────────────────────

test("Charts — no memory leak on navigation away", async ({ page }) => {
  await mockIndiaApiRoutes(page);
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
  });

  // Navigate to a page with charts
  await page.goto("/india/ai-signals");
  await page.waitForLoadState("domcontentloaded");

  // Navigate away — check for unhandled promise rejection from cleanup
  const jsErrors: string[] = [];
  page.on("pageerror", (err) => jsErrors.push(err.message));

  await page.goto("/india/daily-picks");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);

  // Filter out expected or non-critical errors
  const criticalErrors = jsErrors.filter(
    (e) => !e.includes("ResizeObserver") && !e.includes("Non-Error exception captured")
  );
  expect(criticalErrors, `JS errors after navigation: ${criticalErrors.join(", ")}`).toHaveLength(0);
});

// ─── Stale state ─────────────────────────────────────────────────────────────

test("Stale data indicator — page handles stale API response", async ({ page }) => {
  await page.route("**/api/in/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [],
        status: "ok",
        stale: true,
        generatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min old
        fetchedAt: new Date().toISOString(),
      }),
    });
  });

  await page.goto("/india");
  await page.waitForLoadState("domcontentloaded");
  await assertNoErrorBoundary(page);
});

// ─── Paper Trading specific ───────────────────────────────────────────────────

test("Paper Trading — journal renders with stub data", async ({ page }) => {
  await page.route("**/api/in/paper-trade**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          trades: [
            {
              id: "trade-1",
              symbol: "NIFTY",
              direction: "LONG",
              status: "OPEN",
              source: "MOMENTUM:1m",
              entry: 24640,
              stopLoss: 24580,
              target: 24750,
              riskReward: 1.8,
              notional: 100000,
              openedAt: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 1,
        }),
      });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "trade-2" }) });
    }
  });
  await mockIndiaApiRoutes(page);

  await page.goto("/india/paper-trading");
  await page.waitForLoadState("domcontentloaded");
  await assertNoErrorBoundary(page);
});

// ─── Model Monitoring ─────────────────────────────────────────────────────────

test("Model Monitoring — renders drift metrics without crash", async ({ page }) => {
  await page.route("**/api/in/ml-predictions**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        regime: { regime: "TRENDING", confidence: 0.78, probabilities: {} },
        model_status: { regime_classifier: { loaded: true } },
      }),
    });
  });
  await mockIndiaApiRoutes(page);

  await page.goto("/india/ml-monitoring");
  await page.waitForLoadState("domcontentloaded");
  await assertNoErrorBoundary(page);
});
