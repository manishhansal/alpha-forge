import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryBackend } from "@/services/india/cache/memory";

describe("services/india/cache/memory", () => {
  afterEach(async () => {
    await memoryBackend.clear();
    vi.useRealTimers();
  });

  it("get() returns undefined for an unset key", async () => {
    expect(await memoryBackend.get<unknown>("nope")).toBeUndefined();
  });

  it("set() then get() round-trips", async () => {
    await memoryBackend.set("a", { x: 1 }, 1_000);
    expect(await memoryBackend.get<{ x: number }>("a")).toEqual({ x: 1 });
  });

  it("expires entries past their TTL", async () => {
    vi.useFakeTimers();
    await memoryBackend.set("a", "live", 1_000);
    vi.advanceTimersByTime(2_000);
    expect(await memoryBackend.get<string>("a")).toBeUndefined();
  });

  it("invalidate() removes a single key", async () => {
    await memoryBackend.set("a", 1, 5_000);
    await memoryBackend.set("b", 2, 5_000);
    await memoryBackend.invalidate("a");
    expect(await memoryBackend.get<number>("a")).toBeUndefined();
    expect(await memoryBackend.get<number>("b")).toBe(2);
  });

  it("clear() removes everything", async () => {
    await memoryBackend.set("a", 1, 5_000);
    await memoryBackend.set("b", 2, 5_000);
    await memoryBackend.clear();
    expect(await memoryBackend.get<number>("a")).toBeUndefined();
    expect(await memoryBackend.get<number>("b")).toBeUndefined();
  });

  it("publishes the 'memory' backend id", () => {
    expect(memoryBackend.id).toBe("memory");
  });

  it("preserves reference equality for stored objects", async () => {
    const ref = { tag: "live" };
    await memoryBackend.set("ref", ref, 5_000);
    const back = await memoryBackend.get<typeof ref>("ref");
    expect(back).toBe(ref);
  });
});
