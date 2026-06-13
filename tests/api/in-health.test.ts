import { describe, expect, it, vi } from "vitest";

// Mock the cache module so we can drive the round-trip behaviour.
vi.mock("@/services/india/cache", () => {
  const store = new Map<string, unknown>();
  return {
    cache: {
      backendId: "memory",
      get: vi.fn(async (k: string) => store.get(k)),
      set: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      invalidate: vi.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

import { GET } from "@/app/api/in/health/route";

describe("API /api/in/health", () => {
  it("reports cache backend, broker default, and round-trip", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cache.backend).toBe("memory");
    expect(body.cache.roundTrip).toBe("ok");
    expect(typeof body.broker).toBe("string");
    expect(body).toHaveProperty("fetchedAt");
  });

  it("publishes a parseable ISO fetchedAt", async () => {
    const res = await GET();
    const body = await res.json();
    expect(() => new Date(body.fetchedAt).toISOString()).not.toThrow();
  });
});
