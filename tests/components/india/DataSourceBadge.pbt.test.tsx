/**
 * Property-Based Test: DataSourceBadge — Property 17
 *
 * **Property 17: DataSourceBadge Display Format**
 *
 * For any active provider identifier `p` in {"scrapling", "angel_one",
 * "upstox", "nse", "yahoo"} and any non-negative integer `latency_ms`,
 * the DataSourceBadge SHALL render a DOM element containing the text
 * `"{TitleCase(p)} ● {latency_ms}ms"` where TitleCase converts underscores
 * to spaces and capitalises each word (e.g. "angel_one" → "Angel One").
 * For any provider string not in the five known identifiers, the component
 * SHALL render no DOM element.
 *
 * **Validates: Requirements 12.1, 12.7**
 *
 * Testing strategy:
 * - Parameterised over all 5 known provider IDs (it.each)
 * - fast-check generates the corpus of non-negative integer latencies
 * - fast-check generates unknown provider strings for the negative case
 * - fetch is mocked at the global level; act() flushes React effects
 */

import * as fc from "fast-check";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataSourceBadge } from "@/components/india/DataSourceBadge";
import type { ProviderId } from "@/lib/market-data/types";

// ── Types ────────────────────────────────────────────────────────────────────

type HealthEntry = { available: boolean; latency_ms: number };
type HealthMap = Record<string, HealthEntry>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mirrors the TitleCase transform in DataSourceBadge.tsx:
 * split on "_", capitalise each word, join with space.
 */
function toTitleCase(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Build a HealthMap that marks only `activeProvider` as available at
 * `latency_ms`, and all others as unavailable.
 */
function buildHealthMap(activeProvider: string, latency_ms: number): HealthMap {
  const allProviders: ProviderId[] = [
    "scrapling",
    "angel_one",
    "upstox",
    "nse",
    "yahoo",
  ];
  const map: HealthMap = {};
  for (const p of allProviders) {
    map[p] =
      p === activeProvider
        ? { available: true, latency_ms }
        : { available: false, latency_ms: 0 };
  }
  // If activeProvider is not one of the 5 known ones, add it explicitly so
  // the component can (attempt to) display it — the component will still
  // render nothing because the unknown id won't appear in PROVIDER_PRIORITY.
  if (!allProviders.includes(activeProvider as ProviderId)) {
    map[activeProvider] = { available: true, latency_ms };
  }
  return map;
}

/**
 * Render <DataSourceBadge /> with a mocked health response and flush all
 * pending React effects + microtasks so the component can update state.
 *
 * The component uses an async `poll()` function inside `useEffect`. To drive
 * it without a running event loop we:
 *  1. stub `fetch` to resolve synchronously (via Promise.resolve)
 *  2. wrap render + microtask flush inside `act()`
 *  3. use real timers (no fake timers) so waitFor / act work normally
 */
async function renderWithHealth(healthMap: HealthMap): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, _opts?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(healthMap), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );

  // Wrap render in act() so React batches and flushes the initial effect +
  // state update in one synchronous pass (jsdom / React 18 concurrent mode).
  await act(async () => {
    render(<DataSourceBadge />);
    // Flush the microtask queue so the fetch Promise resolves and setState is
    // called before act() exits.
    await Promise.resolve();
    await Promise.resolve(); // two ticks: fetch resolve + json() resolve
    await Promise.resolve(); // third tick: setState
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── Known providers + expected colours ───────────────────────────────────────

const KNOWN_PROVIDERS: Array<{
  id: ProviderId;
  expectedTitle: string;
  expectedColor: string;
}> = [
  {
    id: "scrapling",
    expectedTitle: "Scrapling",
    expectedColor: "var(--color-data-positive)",
  },
  {
    id: "angel_one",
    expectedTitle: "Angel One",
    expectedColor: "var(--color-data-positive)",
  },
  {
    id: "upstox",
    expectedTitle: "Upstox",
    expectedColor: "var(--color-data-neutral)",
  },
  {
    id: "nse",
    expectedTitle: "Nse",
    expectedColor: "var(--color-data-neutral)",
  },
  {
    id: "yahoo",
    expectedTitle: "Yahoo",
    expectedColor: "var(--color-data-negative)",
  },
];

// ── Property 17: Known providers ─────────────────────────────────────────────

describe("Property 17 — DataSourceBadge display format", () => {
  /**
   * For each of the 5 known providers, fast-check generates a corpus of
   * non-negative integer latencies and asserts:
   *   - The badge renders with the correct TitleCase label + latency text
   *   - The background colour matches the provider tier mapping (Req 12.2)
   *   - data-provider attribute exposes the raw provider id
   *
   * Requirement 12.1, 12.7
   */
  it.each(KNOWN_PROVIDERS)(
    "renders '$expectedTitle ● {N}ms' for provider '$id' across many latency values",
    async ({ id, expectedTitle, expectedColor }) => {
      await fc.assert(
        fc.asyncProperty(
          // Non-negative integers — representative range for latency_ms.
          fc.integer({ min: 0, max: 100_000 }),
          async (latency_ms) => {
            cleanup(); // clear between fast-check runs

            const healthMap = buildHealthMap(id, latency_ms);
            await renderWithHealth(healthMap);

            const badge = screen.queryByTestId("data-source-badge");

            // Requirement 12.1 — badge element must be present
            expect(badge).not.toBeNull();

            const expectedText = `${expectedTitle} ● ${latency_ms}ms`;

            // Requirement 12.1 — correct label text
            expect(badge!.textContent).toBe(expectedText);

            // Requirement 12.2 — correct background colour CSS variable
            expect((badge as HTMLElement).style.backgroundColor).toBe(
              expectedColor,
            );

            // data-provider attribute exposes the raw id for programmatic use
            expect(badge!.getAttribute("data-provider")).toBe(id);
          },
        ),
        { numRuns: 20, seed: 42 },
      );
    },
    // Generous timeout: 20 runs × ~50ms each = ~1s, but allow 30s headroom.
    30_000,
  );

  /**
   * Spot-check: latency value 0 is always valid (non-negative integer boundary
   * value). Verifies the badge renders "…● 0ms", not "…● NaNms" or similar.
   */
  it.each(KNOWN_PROVIDERS)(
    "renders '$expectedTitle ● 0ms' at latency boundary (0) for provider '$id'",
    async ({ id, expectedTitle, expectedColor }) => {
      const healthMap = buildHealthMap(id, 0);
      await renderWithHealth(healthMap);

      const badge = screen.getByTestId("data-source-badge");
      expect(badge.textContent).toBe(`${expectedTitle} ● 0ms`);
      expect((badge as HTMLElement).style.backgroundColor).toBe(expectedColor);
    },
  );

  /**
   * Property 17 (negative case): for any provider string that is NOT one of
   * the five known identifiers, the DataSourceBadge SHALL render nothing.
   *
   * fast-check generates arbitrary strings filtered to exclude the 5 known IDs.
   * The component resolves the active provider via PROVIDER_PRIORITY — an
   * unknown provider will never match, so resolveActiveProvider returns null
   * and the badge stays hidden.
   *
   * Requirement 12.7
   */
  it(
    "renders nothing for any unknown provider string",
    async () => {
      const knownSet = new Set<string>([
        "scrapling",
        "angel_one",
        "upstox",
        "nse",
        "yahoo",
      ]);

      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ minLength: 1, maxLength: 40 })
            .filter((s) => !knownSet.has(s)),
          async (unknownProvider) => {
            cleanup();

            // Only the unknown provider is available; the known 5 are all absent.
            const healthMap: HealthMap = {
              [unknownProvider]: { available: true, latency_ms: 10 },
            };
            await renderWithHealth(healthMap);

            const badge = screen.queryByTestId("data-source-badge");

            // Requirement 12.7 — unknown provider → no DOM element
            expect(badge).toBeNull();
          },
        ),
        { numRuns: 30, seed: 99 },
      );
    },
    30_000,
  );

  /**
   * Additional invariant: latency_ms is always rendered as a non-negative
   * integer. The component applies `Math.max(0, Math.floor(entry.latency_ms))`.
   * fast-check generates fractional latency values from the health API and
   * verifies the rendered integer is correctly floored and non-negative.
   */
  it(
    "renders latency as a non-negative integer regardless of fractional API value",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            provider: fc.constantFrom<ProviderId>(
              "scrapling",
              "angel_one",
              "upstox",
              "nse",
              "yahoo",
            ),
            rawLatency: fc.float({ min: 0, max: 50_000, noNaN: true }),
          }),
          async ({ provider, rawLatency }) => {
            cleanup();

            const healthMap = buildHealthMap(provider, rawLatency);
            await renderWithHealth(healthMap);

            const badge = screen.queryByTestId("data-source-badge");
            expect(badge).not.toBeNull();

            const text = badge!.textContent ?? "";

            // Extract the numeric portion before "ms"
            const match = text.match(/(\d+)ms$/);
            expect(match).not.toBeNull();

            const renderedLatency = parseInt(match![1], 10);

            // Must equal Math.max(0, Math.floor(rawLatency))
            const expectedLatency = Math.max(0, Math.floor(rawLatency));
            expect(renderedLatency).toBe(expectedLatency);
          },
        ),
        { numRuns: 25, seed: 7 },
      );
    },
    30_000,
  );

  /**
   * TitleCase helper parity: the test's own `toTitleCase` mirrors the
   * component's implementation. This parameterised sanity check verifies
   * the expected titles in KNOWN_PROVIDERS are consistent with the helper.
   */
  it.each(KNOWN_PROVIDERS)(
    "toTitleCase('$id') === '$expectedTitle'",
    ({ id, expectedTitle }) => {
      expect(toTitleCase(id)).toBe(expectedTitle);
    },
  );
});
