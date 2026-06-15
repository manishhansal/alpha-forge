import { describe, expect, it } from "vitest";

import {
  parseFunds,
  parseHoldings,
  parsePositions,
} from "@/services/india/angelone/portfolio";

describe("services/india/angelone/portfolio — parseFunds", () => {
  it("normalises the string-valued RMS payload to numbers", () => {
    const funds = parseFunds({
      net: "15000.50",
      availablecash: "12000.25",
      availableintradaypayin: "0",
      availablelimitmargin: "5000",
      collateral: "0",
      m2munrealized: "-250.75",
      m2mrealized: "100",
      utiliseddebits: "3000",
    });
    expect(funds.net).toBeCloseTo(15000.5, 2);
    expect(funds.availableCash).toBeCloseTo(12000.25, 2);
    expect(funds.m2mUnrealized).toBeCloseTo(-250.75, 2);
    expect(funds.utilisedDebits).toBeCloseTo(3000, 2);
  });

  it("yields nulls for missing / non-numeric fields", () => {
    const funds = parseFunds({ net: "abc" });
    expect(funds.net).toBeNull();
    expect(funds.availableCash).toBeNull();
  });

  it("handles a null/garbage payload without throwing", () => {
    const funds = parseFunds(null);
    expect(funds.net).toBeNull();
  });
});

describe("services/india/angelone/portfolio — parseHoldings", () => {
  it("parses the getAllHolding {holdings,totalholding} shape", () => {
    const res = parseHoldings({
      holdings: [
        {
          tradingsymbol: "TATASTEEL-EQ",
          exchange: "NSE",
          symboltoken: "3499",
          quantity: 2,
          averageprice: 111.87,
          ltp: 130.95,
          close: 129.6,
          profitandloss: 38,
          pnlpercentage: 17.05,
          product: "DELIVERY",
        },
      ],
      totalholding: {
        totalholdingvalue: 261,
        totalinvvalue: 223,
        totalprofitandloss: 38,
        totalpnlpercentage: 17.05,
      },
    });
    expect(res.holdings).toHaveLength(1);
    expect(res.holdings[0].symbol).toBe("TATASTEEL-EQ");
    expect(res.holdings[0].quantity).toBe(2);
    expect(res.holdings[0].ltp).toBeCloseTo(130.95, 2);
    expect(res.holdings[0].pnl).toBeCloseTo(38, 2);
    expect(res.summary?.totalValue).toBeCloseTo(261, 2);
    expect(res.summary?.totalPnl).toBeCloseTo(38, 2);
  });

  it("accepts a bare holdings array (legacy getHolding) with no summary", () => {
    const res = parseHoldings([
      {
        tradingsymbol: "INFY-EQ",
        symboltoken: "1594",
        quantity: 5,
        averageprice: 1500,
        ltp: 1600,
      },
    ]);
    expect(res.holdings).toHaveLength(1);
    expect(res.holdings[0].symbol).toBe("INFY-EQ");
    expect(res.summary).toBeNull();
  });

  it("returns empty holdings for garbage input", () => {
    expect(parseHoldings(null).holdings).toEqual([]);
  });
});

describe("services/india/angelone/portfolio — parsePositions", () => {
  it("normalises the getPosition array (string fields → numbers)", () => {
    const positions = parsePositions([
      {
        exchange: "NSE",
        symboltoken: "2885",
        producttype: "DELIVERY",
        tradingsymbol: "RELIANCE-EQ",
        symbolname: "RELIANCE",
        netqty: "1",
        buyqty: "1",
        sellqty: "0",
        buyavgprice: "2235.80",
        sellavgprice: "0",
        avgnetprice: "2235.80",
        ltp: "2300.00",
        pnl: "64.20",
      },
    ]);
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.symbol).toBe("RELIANCE-EQ");
    expect(p.name).toBe("RELIANCE");
    expect(p.netQty).toBe(1);
    expect(p.avgNetPrice).toBeCloseTo(2235.8, 2);
    expect(p.ltp).toBeCloseTo(2300, 2);
    expect(p.pnl).toBeCloseTo(64.2, 2);
  });

  it("tolerates the space-prefixed signed numbers SmartAPI sometimes returns", () => {
    const [p] = parsePositions([
      { tradingsymbol: "X-EQ", netqty: "-2", netvalue: "- 4471.60", pnl: "- 12.50" },
    ]);
    expect(p.netQty).toBe(-2);
    expect(p.pnl).toBeCloseTo(-12.5, 2);
  });

  it("returns an empty array for non-array input", () => {
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions({})).toEqual([]);
  });
});
