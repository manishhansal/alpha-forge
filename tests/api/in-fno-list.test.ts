import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/in/fno-list/route";

describe("API /api/in/fno-list", () => {
  it("returns the canonical F&O universe", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("indices");
    expect(body).toHaveProperty("stocks");
    expect(body).toHaveProperty("optionUnderlyings");
    expect(body).toHaveProperty("count");
    expect(Array.isArray(body.indices)).toBe(true);
    expect(Array.isArray(body.stocks)).toBe(true);
  });

  it("each index entry has name + symbol + underlying", async () => {
    const res = await GET();
    const body = await res.json();
    for (const idx of body.indices) {
      expect(idx).toHaveProperty("name");
      expect(idx).toHaveProperty("symbol");
      expect(idx).toHaveProperty("underlying");
    }
  });

  it("each stock entry has a sector list", async () => {
    const res = await GET();
    const body = await res.json();
    for (const s of body.stocks.slice(0, 5)) {
      expect(s).toHaveProperty("symbol");
      expect(Array.isArray(s.sectors)).toBe(true);
    }
  });

  it("count.indices === indices.length and count.stocks === stocks.length", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.count.indices).toBe(body.indices.length);
    expect(body.count.stocks).toBe(body.stocks.length);
  });
});
