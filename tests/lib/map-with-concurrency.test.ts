import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "@/lib/map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("returns results in input order even when tasks settle out of order", async () => {
    const result = await mapWithConcurrency([10, 30, 20, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(result).toEqual([20, 60, 40, 10]);
  });

  it("respects the concurrency cap (never runs more than `n` tasks in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("returns an empty array when the input is empty", async () => {
    const result = await mapWithConcurrency<number, number>([], 4, async (n) => n);
    expect(result).toEqual([]);
  });

  it("isolates per-item failures via a per-item try/catch and falls back to the supplied default", async () => {
    const result = await mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n * 10;
      },
      { onError: () => -1 },
    );
    expect(result).toEqual([10, -1, 30, 40]);
  });
});
