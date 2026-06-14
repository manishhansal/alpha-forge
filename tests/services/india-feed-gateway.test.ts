// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildFeedStream } from "@/services/india/websocket/gateway";
import type { Quote } from "@/types/india";

function makeQuote(symbol: string, price: number): Quote {
  return {
    symbol,
    name: symbol,
    price,
    change: null,
    changePct: 1.2,
    prevClose: null,
    volume: 100,
    fetchedAt: new Date().toISOString(),
  };
}

async function readFirstEvent(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    const { value } = await reader.read();
    return value ? dec.decode(value) : "";
  } finally {
    await reader.cancel();
  }
}

describe("services/india/websocket/gateway", () => {
  it("emits an initial snapshot using the injected quote fetcher", async () => {
    const calls: string[][] = [];
    const fetchQuotes = async (symbols: string[]): Promise<Quote[]> => {
      calls.push(symbols);
      return symbols.map((s, i) => makeQuote(s, 100 + i));
    };

    const stream = buildFeedStream({
      symbols: ["RELIANCE", "TCS"],
      intervalMs: 5_000,
      fetchQuotes,
    });

    const first = await readFirstEvent(stream);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toEqual(["RELIANCE", "TCS"]);
    expect(first).toContain("data:");
    expect(first).toContain("RELIANCE");
    expect(first).toContain("100");
  });

  it("falls back to the Yahoo fetcher when none is injected (no throw)", async () => {
    const stream = buildFeedStream({ symbols: [], intervalMs: 5_000 });
    // Empty symbol set still produces a valid initial snapshot event.
    const first = await readFirstEvent(stream);
    expect(first).toContain("data:");
  });
});
