import { describe, expect, it } from "vitest";

import { isNseMarketOpenIST } from "@/lib/india/market-hours";

describe("lib/india/market-hours — isNseMarketOpenIST", () => {
  it("is open on a weekday between 09:15 and 15:30 IST", () => {
    // 2026-06-10 is a Wednesday. 05:00 UTC = 10:30 IST.
    expect(isNseMarketOpenIST(new Date("2026-06-10T05:00:00Z"))).toBe(true);
  });

  it("is closed before the 09:15 IST open", () => {
    // 03:30 UTC = 09:00 IST.
    expect(isNseMarketOpenIST(new Date("2026-06-10T03:30:00Z"))).toBe(false);
  });

  it("is open exactly at 15:30 IST and closed a minute later", () => {
    // 10:00 UTC = 15:30 IST.
    expect(isNseMarketOpenIST(new Date("2026-06-10T10:00:00Z"))).toBe(true);
    expect(isNseMarketOpenIST(new Date("2026-06-10T10:01:00Z"))).toBe(false);
  });

  it("is closed on weekends", () => {
    // 2026-06-13 is a Saturday; 2026-06-14 a Sunday. 05:00 UTC = 10:30 IST.
    expect(isNseMarketOpenIST(new Date("2026-06-13T05:00:00Z"))).toBe(false);
    expect(isNseMarketOpenIST(new Date("2026-06-14T05:00:00Z"))).toBe(false);
  });
});
