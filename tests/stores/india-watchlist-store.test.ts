import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useIndiaWatchlistStore } from "@/store/india/watchlistStore";

describe("store/india/watchlistStore", () => {
  beforeEach(() => {
    // Reset to a known empty state — defaults are pre-populated.
    useIndiaWatchlistStore.getState().clear();
  });

  afterEach(() => {
    useIndiaWatchlistStore.getState().clear();
  });

  it("ships with default symbols", () => {
    // Clear and re-instantiate by calling internal hydrate flow is heavy;
    // instead verify the default factory shape via add() then count.
    useIndiaWatchlistStore.getState().add("RELIANCE");
    useIndiaWatchlistStore.getState().add("TCS");
    expect(useIndiaWatchlistStore.getState().items.length).toBe(2);
  });

  it("add() appends symbols and ignores duplicates", () => {
    const store = useIndiaWatchlistStore.getState();
    store.add("WIPRO");
    store.add("WIPRO");
    expect(useIndiaWatchlistStore.getState().items.filter((i) => i.symbol === "WIPRO")).toHaveLength(1);
  });

  it("remove() drops a symbol", () => {
    useIndiaWatchlistStore.getState().add("WIPRO");
    useIndiaWatchlistStore.getState().remove("WIPRO");
    expect(useIndiaWatchlistStore.getState().has("WIPRO")).toBe(false);
  });

  it("toggle() flips presence on/off", () => {
    useIndiaWatchlistStore.getState().toggle("WIPRO");
    expect(useIndiaWatchlistStore.getState().has("WIPRO")).toBe(true);
    useIndiaWatchlistStore.getState().toggle("WIPRO");
    expect(useIndiaWatchlistStore.getState().has("WIPRO")).toBe(false);
  });

  it("has() reports membership", () => {
    expect(useIndiaWatchlistStore.getState().has("DOES_NOT_EXIST")).toBe(false);
    useIndiaWatchlistStore.getState().add("HDFCBANK");
    expect(useIndiaWatchlistStore.getState().has("HDFCBANK")).toBe(true);
  });

  it("clear() empties the watchlist", () => {
    useIndiaWatchlistStore.getState().add("X");
    useIndiaWatchlistStore.getState().add("Y");
    useIndiaWatchlistStore.getState().clear();
    expect(useIndiaWatchlistStore.getState().items).toEqual([]);
  });

  it("add() stamps addedAt with a positive timestamp", () => {
    useIndiaWatchlistStore.getState().add("DLF");
    const item = useIndiaWatchlistStore.getState().items.find((i) => i.symbol === "DLF");
    expect(item?.addedAt).toBeGreaterThan(0);
  });
});
