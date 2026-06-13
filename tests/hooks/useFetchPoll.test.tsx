import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { getJson, useFetchPoll } from "@/hooks/india/useFetchPoll";

describe("hooks/india/useFetchPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls the loader on mount and pipes data into onData", async () => {
    const loader = vi.fn(async () => ({ value: 1 }));
    const onData = vi.fn();
    renderHook(() =>
      useFetchPoll(loader, onData, { intervalMs: 60_000 }, []),
    );
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledWith({ value: 1 });
    });
  });

  it("invokes onError on a failed loader", async () => {
    const err = new Error("boom");
    const loader = vi.fn(async () => {
      throw err;
    });
    const onData = vi.fn();
    const onError = vi.fn();
    renderHook(() =>
      useFetchPoll(loader, onData, { intervalMs: 60_000, onError }, []),
    );
    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(err);
    });
    expect(onData).not.toHaveBeenCalled();
  });

  it("aborts the in-flight controller on unmount", async () => {
    const onAbort = vi.fn();
    const loader = vi.fn(async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => onAbort());
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { unmount } = renderHook(() =>
      useFetchPoll(loader, () => undefined, { intervalMs: 60_000 }, []),
    );
    // Wait for the initial tick to start.
    await waitFor(() => expect(loader).toHaveBeenCalled());
    act(() => {
      unmount();
    });
    expect(onAbort).toHaveBeenCalled();
  });
});

describe("hooks/india/useFetchPoll → getJson()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed JSON on a 200 response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await getJson("/x", new AbortController().signal);
    expect(out).toEqual({ ok: true });
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("server died", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getJson("/x", new AbortController().signal)).rejects.toThrow(/HTTP 500/);
  });
});
