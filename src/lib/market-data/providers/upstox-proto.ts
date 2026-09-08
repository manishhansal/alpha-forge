/**
 * Upstox v3 Market Data Feed — minimal Protobuf decoder.
 *
 * The Upstox v3 WebSocket feed (wss://wsfeeder-api.upstox.com/.../v3/...) sends
 * binary Protobuf frames encoded per the official schema published at
 *   https://assets.upstox.com/feed/market-data-feed/v1/MarketDataFeed.proto
 * (the v3 feed reuses the same message shapes; v3 only adds an extra
 * `firstLevelWithGreeks` variant to FullFeed that we do not need here).
 *
 * Rather than pull in the full protobufjs runtime plus a generated schema
 * (heavy, and server-side only), we hand-roll a wire-format reader that walks
 * exactly the fields we consume: instrument key + LTPC (ltp/ltt/ltq/cp) and the
 * extended-feed volume/open-interest.  The output object is shaped to match the
 * `UpstoxWsInstrumentFeed` structure the JSON path produced, so `dispatchFeed`
 * needs no changes.
 *
 * Relevant field numbers (from the official v3 .proto at
 *   https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto):
 *   FeedResponse         : type=1 (enum), feeds=2 (map<string, Feed>), currentTs=3, marketInfo=4
 *   map<string,Feed>entry: key=1 (string), value=2 (Feed message)
 *   Feed                 : ltpc=1 (LTPC), fullFeed=2 (FullFeed),
 *                          firstLevelWithGreeks=3, requestMode=4
 *   FullFeed             : marketFF=1 (MarketFullFeed), indexFF=2 (IndexFullFeed)
 *   MarketFullFeed (v3, FLAT): ltpc=1, marketLevel=2, optionGreeks=3, marketOHLC=4,
 *                          atp=5(double), vtt=6(int64), oi=7(double), iv=8, ...
 *   IndexFullFeed        : ltpc=1, marketOHLC=2
 *   FirstLevelWithGreeks : ltpc=1, firstDepth=2, optionGreeks=3, vtt=4(int64), oi=5(double)
 *   LTPC                 : ltp=1 (double), ltt=2 (int64), ltq=3 (int64), cp=4 (double)
 *
 * NOTE: v3 flattened volume/OI onto MarketFullFeed (the v1 nested
 * `ExtendedFeedDetails` message no longer exists).  We still expose them under an
 * `eFeedDetails` object so the dispatcher in upstox.ts needs no changes.
 *
 * Wire types used: 0 = varint, 1 = 64-bit (double/fixed64), 2 = length-delimited.
 *
 * This module is pure and dependency-free — safe to unit test with a fixed
 * byte buffer.
 */

/** Shape consumed by UpstoxWsManager.dispatchFeed (mirrors the JSON feed). */
export interface DecodedInstrumentFeed {
  ff?: {
    marketFF?: {
      ltpc?: { ltp?: number; ltt?: number; ltq?: number; cp?: number };
      eFeedDetails?: { vtt?: number; oi?: number };
    };
    indexFF?: {
      ltpc?: { ltp?: number; ltt?: number; ltq?: number; cp?: number };
    };
  };
}

/** A single length-delimited protobuf field walker. */
class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /**
   * Read a base-128 varint (unsigned). Returns a JS number.
   * Uses float accumulation so values beyond 32 bits (e.g. millisecond
   * timestamps in `ltt`) stay accurate up to Number.MAX_SAFE_INTEGER.
   */
  readVarint(): number {
    let result = 0;
    let multiplier = 1;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) break;
      multiplier *= 128;
    }
    return result;
  }

  /** Read the field tag; returns {fieldNumber, wireType}. */
  readTag(): { field: number; wire: number } {
    const key = this.readVarint();
    return { field: key >>> 3, wire: key & 0x7 };
  }

  /** Read a IEEE-754 double (wire type 1, little-endian 8 bytes). */
  readDouble(): number {
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    const val = dv.getFloat64(0, true);
    this.pos += 8;
    return val;
  }

  /** Read a length-delimited chunk (wire type 2). */
  readBytes(): Uint8Array {
    const len = this.readVarint();
    const chunk = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return chunk;
  }

  /** Read a length-delimited UTF-8 string. */
  readString(): string {
    return Buffer.from(this.readBytes()).toString("utf8");
  }

  /** Skip a field of the given wire type. */
  skip(wire: number): void {
    switch (wire) {
      case 0: // varint
        this.readVarint();
        break;
      case 1: // 64-bit
        this.pos += 8;
        break;
      case 2: // length-delimited
        this.readBytes();
        break;
      case 5: // 32-bit
        this.pos += 4;
        break;
      default:
        // Unknown/deprecated group wire types — stop to avoid runaway.
        this.pos = this.buf.length;
    }
  }
}

interface Ltpc {
  ltp?: number;
  ltt?: number;
  ltq?: number;
  cp?: number;
}

function decodeLtpc(buf: Uint8Array): Ltpc {
  const r = new Reader(buf);
  const out: Ltpc = {};
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 1) out.ltp = r.readDouble();
    else if (field === 2 && wire === 0) out.ltt = r.readVarint();
    else if (field === 3 && wire === 0) out.ltq = r.readVarint();
    else if (field === 4 && wire === 1) out.cp = r.readDouble();
    else r.skip(wire);
  }
  return out;
}

interface MarketFF {
  ltpc?: Ltpc;
  eFeedDetails?: { vtt?: number; oi?: number };
}

/**
 * MarketFullFeed (v3): ltpc=1, marketLevel=2, optionGreeks=3, marketOHLC=4,
 * atp=5(double), vtt=6(int64), oi=7(double), iv=8, ...  Volume/OI are FLAT
 * top-level fields in v3 (the v1 nested `eFeedDetails` message is gone).  We
 * still surface them under `eFeedDetails` so the dispatcher stays unchanged.
 */
function decodeMarketFullFeed(buf: Uint8Array): MarketFF {
  const r = new Reader(buf);
  const out: MarketFF = {};
  let vtt: number | undefined;
  let oi: number | undefined;
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 2) out.ltpc = decodeLtpc(r.readBytes());
    else if (field === 6 && wire === 0) vtt = r.readVarint();      // vtt (volume traded today)
    else if (field === 7 && wire === 1) oi = r.readDouble();       // oi (open interest)
    else r.skip(wire);
  }
  if (vtt != null || oi != null) out.eFeedDetails = { vtt, oi };
  return out;
}

/** IndexFullFeed: ltpc=1. */
function decodeIndexFullFeed(buf: Uint8Array): { ltpc?: Ltpc } {
  const r = new Reader(buf);
  const out: { ltpc?: Ltpc } = {};
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 2) out.ltpc = decodeLtpc(r.readBytes());
    else r.skip(wire);
  }
  return out;
}

/** FullFeed: marketFF=1, indexFF=2. */
function decodeFullFeed(buf: Uint8Array): DecodedInstrumentFeed["ff"] {
  const r = new Reader(buf);
  const ff: NonNullable<DecodedInstrumentFeed["ff"]> = {};
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 2) ff.marketFF = decodeMarketFullFeed(r.readBytes());
    else if (field === 2 && wire === 2) ff.indexFF = decodeIndexFullFeed(r.readBytes());
    else r.skip(wire);
  }
  return ff;
}

/**
 * Feed (v3): ltpc=1, fullFeed=2, firstLevelWithGreeks=3, requestMode=4.
 * We normalise a bare `ltpc` (ltpc mode) and `firstLevelWithGreeks` into a
 * feed the dispatcher can read via `ff?.marketFF?.ltpc ?? ff?.indexFF?.ltpc`.
 */
function decodeFeed(buf: Uint8Array): DecodedInstrumentFeed {
  const r = new Reader(buf);
  const out: DecodedInstrumentFeed = {};
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 2) {
      // Bare LTPC (ltpc subscription mode).
      const ltpc = decodeLtpc(r.readBytes());
      out.ff = { ...(out.ff ?? {}), indexFF: { ltpc } };
    } else if (field === 2 && wire === 2) {
      out.ff = decodeFullFeed(r.readBytes());
    } else if (field === 3 && wire === 2) {
      // FirstLevelWithGreeks (option_greeks mode): ltpc=1, vtt=4, oi=5.
      out.ff = { ...(out.ff ?? {}), marketFF: decodeFirstLevelWithGreeks(r.readBytes()) };
    } else {
      r.skip(wire);
    }
  }
  return out;
}

/** FirstLevelWithGreeks (v3): ltpc=1, firstDepth=2, optionGreeks=3, vtt=4(int64), oi=5(double). */
function decodeFirstLevelWithGreeks(buf: Uint8Array): MarketFF {
  const r = new Reader(buf);
  const out: MarketFF = {};
  let vtt: number | undefined;
  let oi: number | undefined;
  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 2) out.ltpc = decodeLtpc(r.readBytes());
    else if (field === 4 && wire === 0) vtt = r.readVarint();
    else if (field === 5 && wire === 1) oi = r.readDouble();
    else r.skip(wire);
  }
  if (vtt != null || oi != null) out.eFeedDetails = { vtt, oi };
  return out;
}

/**
 * Decode a full Upstox v3 FeedResponse frame.
 *
 * FeedResponse (v3): type=1(enum), feeds=2(map<string,Feed>), currentTs=3(int64),
 * marketInfo=4.  The `market_info` (type=2) frame Upstox emits on connect and at
 * session transitions carries no `feeds`, so it decodes to an empty map — that is
 * expected, not an error.
 *
 * @returns a map of instrumentKey → DecodedInstrumentFeed, plus the frame type
 *   ("initial_feed" | "live_feed" | "market_info").
 */
export function decodeFeedResponse(raw: Uint8Array): {
  type?: string;
  feeds: Record<string, DecodedInstrumentFeed>;
} {
  const r = new Reader(raw);
  const feeds: Record<string, DecodedInstrumentFeed> = {};
  let type: string | undefined;

  while (!r.eof) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === 0) {
      const t = r.readVarint();
      type = t === 0 ? "initial_feed" : t === 1 ? "live_feed" : t === 2 ? "market_info" : String(t);
    } else if (field === 2 && wire === 2) {
      // map<string, Feed> entry: field 1 = key (string), field 2 = value (Feed)
      const entry = new Reader(r.readBytes());
      let key = "";
      let feed: DecodedInstrumentFeed = {};
      while (!entry.eof) {
        const kv = entry.readTag();
        if (kv.field === 1 && kv.wire === 2) key = entry.readString();
        else if (kv.field === 2 && kv.wire === 2) feed = decodeFeed(entry.readBytes());
        else entry.skip(kv.wire);
      }
      if (key) feeds[key] = feed;
    } else {
      r.skip(wire);
    }
  }

  return { type, feeds };
}
