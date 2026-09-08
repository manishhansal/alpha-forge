/**
 * Deterministic regression tests for the Upstox v3 Protobuf feed decoder.
 *
 * We build encoded frames with a tiny, independent protobuf writer (varint /
 * fixed64-double / length-delimited only) so the test verifies the decoder
 * against the real wire format rather than against itself.
 *
 * Field numbers mirror the official v3 schema
 *   https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
 *
 *   FeedResponse : type=1(enum), feeds=2(map<string,Feed>), currentTs=3, marketInfo=4
 *   Feed         : ltpc=1, fullFeed=2, firstLevelWithGreeks=3, requestMode=4
 *   FullFeed     : marketFF=1, indexFF=2
 *   MarketFullFeed (FLAT): ltpc=1, atp=5, vtt=6(int64), oi=7(double), iv=8
 *   IndexFullFeed : ltpc=1, marketOHLC=2
 *   LTPC         : ltp=1(double), ltt=2(varint), ltq=3(varint), cp=4(double)
 */
import { describe, it, expect } from "vitest";

import { decodeFeedResponse } from "@/lib/market-data/providers/upstox-proto";

// ── minimal protobuf writer (test-only) ──────────────────────────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}

function double(field: number, value: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return [...tag(field, 1), ...buf];
}

function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function lenField(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function stringField(field: number, value: string): number[] {
  return lenField(field, [...Buffer.from(value, "utf8")]);
}

// LTPC: ltp=1(double), ltt=2(varint), cp=4(double)
function ltpc(ltp: number, ltt: number, cp: number): number[] {
  return [...double(1, ltp), ...varintField(2, ltt), ...double(4, cp)];
}



/** Wrap a single {key -> Feed-value-bytes} into a FeedResponse map entry (field 2). */
function mapEntry(key: string, feedValueBytes: number[]): number[] {
  // entry message: key=field1(string), value=field2(Feed message)
  const entryBytes = [...stringField(1, key), ...lenField(2, feedValueBytes)];
  return lenField(2, entryBytes); // FeedResponse.feeds = field 2
}

/** Build a whole FeedResponse frame from prebuilt map entries. */
function frame(...entries: number[][]): Uint8Array {
  return Uint8Array.from([...varintField(1, 1), ...entries.flat()]);
}

// Feed{ ff{ indexFF{ ltpc } } }
function indexFeed(ltp: number, ltt: number, cp: number): number[] {
  const indexFullFeed = lenField(1, ltpc(ltp, ltt, cp)); // IndexFullFeed.ltpc = 1
  const fullFeed = lenField(2, indexFullFeed);           // FullFeed.indexFF = 2
  return lenField(2, fullFeed);                          // Feed.ff = 2
}

// Feed{ ff{ marketFF{ ltpc, vtt, oi } } } — v3 flattens vtt(f6)/oi(f7) onto MarketFullFeed.
function marketFeed(ltp: number, ltt: number, cp: number, vtt: number, oi: number): number[] {
  const marketFullFeed = [
    ...lenField(1, ltpc(ltp, ltt, cp)),  // MarketFullFeed.ltpc = 1
    ...varintField(6, vtt),              // MarketFullFeed.vtt = 6 (int64)
    ...double(7, oi),                    // MarketFullFeed.oi = 7 (double)
  ];
  const fullFeed = lenField(1, marketFullFeed); // FullFeed.marketFF = 1
  return lenField(2, fullFeed);                 // Feed.ff = 2
}

describe("Upstox v3 Protobuf feed decoder", () => {
  it("decodes an index feed (indexFF → ltpc)", () => {
    const f = frame(mapEntry("NSE_INDEX|Nifty 50", indexFeed(24_050.5, 1_725_000_000_000, 23_900.25)));
    const { type, feeds } = decodeFeedResponse(f);

    expect(type).toBe("live_feed");
    const feed = feeds["NSE_INDEX|Nifty 50"];
    expect(feed).toBeDefined();
    expect(feed.ff?.indexFF?.ltpc?.ltp).toBeCloseTo(24_050.5, 4);
    expect(feed.ff?.indexFF?.ltpc?.cp).toBeCloseTo(23_900.25, 4);
    expect(feed.ff?.indexFF?.ltpc?.ltt).toBe(1_725_000_000_000);
  });

  it("decodes an equity feed with volume + OI (marketFF → eFeedDetails)", () => {
    const f = frame(mapEntry("NSE_EQ|INE002A01018", marketFeed(2_950.75, 1_725_000_111_222, 2_910.0, 2_000_000, 12_345)));
    const { feeds } = decodeFeedResponse(f);
    const feed = feeds["NSE_EQ|INE002A01018"];
    expect(feed.ff?.marketFF?.ltpc?.ltp).toBeCloseTo(2_950.75, 4);
    expect(feed.ff?.marketFF?.ltpc?.cp).toBeCloseTo(2_910.0, 4);
    expect(feed.ff?.marketFF?.eFeedDetails?.vtt).toBe(2_000_000);
    expect(feed.ff?.marketFF?.eFeedDetails?.oi).toBeCloseTo(12_345, 4);
  });

  it("decodes a bare ltpc-mode Feed into indexFF shape", () => {
    // Feed.ltpc = field 1 (ltpc subscription mode, no FullFeed wrapper)
    const feedVal = lenField(1, ltpc(100.5, 1_725_000_000_000, 99.0));
    const f = frame(mapEntry("NSE_EQ|X", feedVal));
    const { feeds } = decodeFeedResponse(f);
    // The dispatcher reads marketFF.ltpc ?? indexFF.ltpc; a bare ltpc lands in indexFF.
    expect(feeds["NSE_EQ|X"].ff?.indexFF?.ltpc?.ltp).toBeCloseTo(100.5, 4);
  });

  it("decodes multiple instruments in one frame", () => {
    const f = frame(
      mapEntry("NSE_INDEX|Nifty 50", indexFeed(24_000, 1_725_000_000_000, 23_999)),
      mapEntry("NSE_INDEX|Nifty Bank", indexFeed(51_000, 1_725_000_000_000, 50_999)),
    );
    const { feeds } = decodeFeedResponse(f);
    expect(Object.keys(feeds).sort()).toEqual([
      "NSE_INDEX|Nifty 50",
      "NSE_INDEX|Nifty Bank",
    ]);
    expect(feeds["NSE_INDEX|Nifty 50"].ff?.indexFF?.ltpc?.ltp).toBeCloseTo(24_000, 4);
    expect(feeds["NSE_INDEX|Nifty Bank"].ff?.indexFF?.ltpc?.ltp).toBeCloseTo(51_000, 4);
  });

  it("skips unknown fields without throwing and returns empty feeds", () => {
    // A frame containing only an unknown field 7 (varint) — e.g. a heartbeat/market-info frame.
    const f = Uint8Array.from([...varintField(7, 42)]);
    const { feeds } = decodeFeedResponse(f);
    expect(feeds).toEqual({});
  });

  it("preserves large 64-bit timestamps without precision loss", () => {
    const ltt = 1_725_123_456_789; // > 2^32
    const f = frame(mapEntry("NSE_INDEX|Nifty 50", indexFeed(1, ltt, 1)));
    const { feeds } = decodeFeedResponse(f);
    expect(feeds["NSE_INDEX|Nifty 50"].ff?.indexFF?.ltpc?.ltt).toBe(ltt);
  });
});
