/**
 * Unit tests for DataSourceBadge component.
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.6, 12.7, 12.8
 */

import {
  act,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataSourceBadge } from "@/components/india/DataSourceBadge";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a health-map response where only `activeProvider` is available. */
function makeHealthMap(
  activeProvider: string,
  latency_ms: number,
): Record<string, { available: boolean; latency_ms: number }> {
  const allProviders = ["scrapling", "angel_one", "upstox", "nse", "yahoo"];
  const map: Record<string, { available: boolean; latency_ms: number }> = {};
  for (const id of allProviders) {
    map[id] = { available: id === activeProvider, latency_ms: id === activeProvider ? latency_ms : 0 };
  }
  return map;
}

/** Create a mock fetch that resolves with the given JSON body. */
function mockFetchResolves(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

/** Create a mock fetch that never resolves (simulates in-flight request). */
function mockFetchPending(): ReturnType<typeof vi.fn> {
  return vi.fn().mockReturnValue(new Promise(() => { /* intentionally never resolves */ }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DataSourceBadge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── Requirement 12.1, 12.2: Renders scrapling with positive color ────────
  it("renders 'Scrapling ● 180ms' with positive background color for provider scrapling", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("scrapling", 180)),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Scrapling ● 180ms");
    expect(badge).toHaveStyle({ backgroundColor: "var(--color-data-positive)" });
  });

  // ── Requirement 12.1, 12.2: Renders angel_one with positive color ────────
  it("renders 'Angel One ● 45ms' with positive background color for provider angel_one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("angel_one", 45)),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Angel One ● 45ms");
    expect(badge).toHaveStyle({ backgroundColor: "var(--color-data-positive)" });
  });

  // ── Requirement 12.2: upstox → neutral color ─────────────────────────────
  it("renders 'Upstox ● 60ms' with neutral background color for provider upstox", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("upstox", 60)),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toHaveTextContent("Upstox ● 60ms");
    expect(badge).toHaveStyle({ backgroundColor: "var(--color-data-neutral)" });
  });

  // ── Requirement 12.2: yahoo → negative color ─────────────────────────────
  it("renders 'Yahoo ● 200ms' with negative background color for provider yahoo", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("yahoo", 200)),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toHaveTextContent("Yahoo ● 200ms");
    expect(badge).toHaveStyle({ backgroundColor: "var(--color-data-negative)" });
  });

  // ── Requirement 12.7: unknown provider → render nothing ─────────────────
  it("renders nothing when the response contains only unknown providers", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves({
        unknown_provider: { available: true, latency_ms: 100 },
      }),
    );

    render(<DataSourceBadge />);

    // Give the component time to resolve the fetch and attempt to render.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.queryByTestId("data-source-badge")).toBeNull();
  });

  // ── Requirement 12.7: no available providers → render nothing ────────────
  it("renders nothing when all providers report available: false", async () => {
    const noProviders: Record<string, { available: boolean; latency_ms: number }> = {
      scrapling: { available: false, latency_ms: 0 },
      angel_one: { available: false, latency_ms: 0 },
      upstox:    { available: false, latency_ms: 0 },
      nse:       { available: false, latency_ms: 0 },
      yahoo:     { available: false, latency_ms: 0 },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchResolves(noProviders));

    render(<DataSourceBadge />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.queryByTestId("data-source-badge")).toBeNull();
  });

  // ── Requirement 12.3: renders nothing while fetch is in-flight ───────────
  it("renders nothing while the /api/in/provider-health fetch is in-flight", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchPending());

    render(<DataSourceBadge />);

    // No await — we check synchronously immediately after render.
    expect(screen.queryByTestId("data-source-badge")).toBeNull();
  });

  // ── Requirement 12.8: AbortController.abort() called on unmount ──────────
  it("calls AbortController.abort() when the component unmounts", async () => {
    const abortSpy = vi.fn();
    const originalAbortController = globalThis.AbortController;

    // Replace AbortController so we can spy on abort().
    vi.stubGlobal("AbortController", class MockAbortController {
      signal = {} as AbortSignal;
      abort = abortSpy;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(mockFetchPending());

    const { unmount } = render(<DataSourceBadge />);

    unmount();

    expect(abortSpy).toHaveBeenCalled();

    vi.stubGlobal("AbortController", originalAbortController);
  });

  // ── Requirement 12.6: polls 30s after response, not on a fixed interval ──
  it("does not make a second fetch before 30s have elapsed after the first response", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("scrapling", 150)),
    );

    render(<DataSourceBadge />);

    // Let the initial fetch run: flush microtasks via a real promise drain.
    await act(async () => {
      // Run fake timers to unblock any timer-gated code, then flush the
      // microtask queue by awaiting a resolved Promise.
      vi.runAllTicks();
      await Promise.resolve();
    });

    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    // Advance timers by less than 30s — no second fetch yet.
    await act(async () => {
      vi.advanceTimersByTime(29_999);
      vi.runAllTicks();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("makes a second fetch exactly after 30s have elapsed since the first response resolved", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("scrapling", 150)),
    );

    render(<DataSourceBadge />);

    // Flush the first poll (initial fetch + state update).
    await act(async () => {
      vi.runAllTicks();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.length).toBe(1);

    // Advance past the 30s mark to trigger the setTimeout callback.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      vi.runAllTicks();
      await Promise.resolve();
    });

    // A second fetch should now have been triggered.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  // ── Requirement 12.1: data-provider attribute correctness ────────────────
  it("sets data-provider attribute matching the active provider id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves(makeHealthMap("nse", 30)),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toHaveAttribute("data-provider", "nse");
  });

  // ── Requirement 12.1: latency_ms floored to non-negative integer ─────────
  it("floors fractional latency_ms to a non-negative integer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves({
        scrapling: { available: true, latency_ms: 123.9 },
        angel_one: { available: false, latency_ms: 0 },
        upstox:    { available: false, latency_ms: 0 },
        nse:       { available: false, latency_ms: 0 },
        yahoo:     { available: false, latency_ms: 0 },
      }),
    );

    render(<DataSourceBadge />);

    const badge = await screen.findByTestId("data-source-badge");
    // Component uses Math.floor(), so 123.9 → 123.
    expect(badge).toHaveTextContent("Scrapling ● 123ms");
  });

  // ── Requirement 12.7: provider priority — highest-priority wins ──────────
  it("displays the highest-priority available provider when multiple are available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      mockFetchResolves({
        scrapling: { available: false, latency_ms: 0 },
        angel_one: { available: true,  latency_ms: 40 },
        upstox:    { available: true,  latency_ms: 80 },
        nse:       { available: false, latency_ms: 0 },
        yahoo:     { available: false, latency_ms: 0 },
      }),
    );

    render(<DataSourceBadge />);

    // angel_one comes before upstox in priority → should win.
    const badge = await screen.findByTestId("data-source-badge");
    expect(badge).toHaveTextContent("Angel One ● 40ms");
  });
});
