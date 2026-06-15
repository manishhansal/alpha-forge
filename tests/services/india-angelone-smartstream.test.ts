// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  SMART_EXCHANGE_TYPE,
  SMART_MODE,
  SmartStreamClient,
  buildSubscribeMessage,
  changePctFromTick,
  parseSmartTick,
} from "@/services/india/angelone/smartstream";

/** Build a Quote-mode (123-byte) SmartStream binary frame for `token`. */
function quoteFrame(token: string): Uint8Array {
  const buf = new ArrayBuffer(123);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setInt8(0, SMART_MODE.QUOTE);
  dv.setInt8(1, SMART_EXCHANGE_TYPE.NSE_CM);
  for (let i = 0; i < token.length; i++) u8[2 + i] = token.charCodeAt(i);
  dv.setBigInt64(27, BigInt(5), true); // sequence
  dv.setBigInt64(35, BigInt(1_700_000_000_000), true); // exchange ts (ms)
  dv.setBigInt64(43, BigInt(290_055), true); // ltp = 2900.55
  dv.setBigInt64(51, BigInt(10), true); // last traded qty
  dv.setBigInt64(59, BigInt(289_000), true); // avg traded price = 2890
  dv.setBigInt64(67, BigInt(123_456), true); // volume
  dv.setFloat64(75, 5_000, true); // total buy qty
  dv.setFloat64(83, 3_000, true); // total sell qty
  dv.setBigInt64(91, BigInt(288_000), true); // open = 2880
  dv.setBigInt64(99, BigInt(295_000), true); // high = 2950
  dv.setBigInt64(107, BigInt(287_000), true); // low = 2870
  dv.setBigInt64(115, BigInt(289_500), true); // close = 2895
  return u8;
}

describe("services/india/angelone/smartstream — parseSmartTick", () => {
  it("returns null for an undersized frame", () => {
    expect(parseSmartTick(new Uint8Array(10))).toBeNull();
  });

  it("parses a Quote-mode frame into rupee-denominated fields", () => {
    const tick = parseSmartTick(quoteFrame("2885"));
    expect(tick).not.toBeNull();
    expect(tick!.mode).toBe(SMART_MODE.QUOTE);
    expect(tick!.exchangeType).toBe(SMART_EXCHANGE_TYPE.NSE_CM);
    expect(tick!.token).toBe("2885");
    expect(tick!.ltp).toBeCloseTo(2900.55, 2);
    expect(tick!.volume).toBe(123_456);
    expect(tick!.totalBuyQty).toBe(5_000);
    expect(tick!.totalSellQty).toBe(3_000);
    expect(tick!.open).toBeCloseTo(2880, 2);
    expect(tick!.close).toBeCloseTo(2895, 2);
  });

  it("stops at LTP fields for an LTP-mode (51-byte) frame", () => {
    const buf = new ArrayBuffer(51);
    const dv = new DataView(buf);
    dv.setInt8(0, SMART_MODE.LTP);
    dv.setInt8(1, SMART_EXCHANGE_TYPE.NSE_FO);
    dv.setBigInt64(43, BigInt(1_234_500), true); // ltp = 12345.00
    const tick = parseSmartTick(new Uint8Array(buf));
    expect(tick!.mode).toBe(SMART_MODE.LTP);
    expect(tick!.ltp).toBeCloseTo(12_345, 2);
    expect(tick!.close).toBeUndefined();
  });
});

describe("services/india/angelone/smartstream — changePctFromTick", () => {
  it("computes percent change from ltp vs previous close", () => {
    expect(changePctFromTick(2900.55, 2895)!).toBeCloseTo(0.1917, 3);
  });
  it("returns null when close is missing or zero", () => {
    expect(changePctFromTick(100, 0)).toBeNull();
    expect(changePctFromTick(100, null)).toBeNull();
  });
});

describe("services/india/angelone/smartstream — buildSubscribeMessage", () => {
  it("groups tokens by exchange type and defaults to subscribe", () => {
    const msg = buildSubscribeMessage({
      tokensByExchangeType: {
        [SMART_EXCHANGE_TYPE.NSE_CM]: ["2885"],
        [SMART_EXCHANGE_TYPE.NSE_FO]: ["26009"],
      },
      mode: SMART_MODE.QUOTE,
    });
    expect(msg.action).toBe(1);
    expect(msg.params.mode).toBe(SMART_MODE.QUOTE);
    expect(msg.params.tokenList).toContainEqual({
      exchangeType: SMART_EXCHANGE_TYPE.NSE_CM,
      tokens: ["2885"],
    });
    expect(msg.params.tokenList).toContainEqual({
      exchangeType: SMART_EXCHANGE_TYPE.NSE_FO,
      tokens: ["26009"],
    });
  });

  it("omits empty exchange buckets", () => {
    const msg = buildSubscribeMessage({
      tokensByExchangeType: { [SMART_EXCHANGE_TYPE.NSE_CM]: [] },
      mode: SMART_MODE.LTP,
    });
    expect(msg.params.tokenList).toHaveLength(0);
  });
});

describe("services/india/angelone/smartstream — SmartStreamClient.handleMessage", () => {
  function client(onTick: (t: ReturnType<typeof parseSmartTick>) => void) {
    return new SmartStreamClient({
      credentials: {
        apiKey: "k",
        clientCode: "c",
        jwt: "j",
        feedToken: "f",
      },
      tokensByExchangeType: { [SMART_EXCHANGE_TYPE.NSE_CM]: ["2885"] },
      onTick: (t) => onTick(t),
    });
  }

  it("emits a parsed tick for a binary frame", () => {
    const ticks: string[] = [];
    client((t) => t && ticks.push(t.token)).handleMessage(quoteFrame("2885"));
    expect(ticks).toEqual(["2885"]);
  });

  it("ignores text heartbeat frames", () => {
    let count = 0;
    const c = client(() => count++);
    c.handleMessage("pong");
    c.handleMessage(Buffer.from("pong"));
    expect(count).toBe(0);
  });
});
