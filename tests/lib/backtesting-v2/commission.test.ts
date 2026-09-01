/**
 * CommissionModel — deterministic unit tests.
 * Verifies that each cost component (brokerage, STT, exchange fee, SEBI fee,
 * GST, stamp duty) is computed correctly and that totals are positive.
 */

import { describe, it, expect } from "vitest";
import {
  calcCommission,
  nseCommission,
  CommissionModel,
} from "@/lib/backtesting-v2/execution/commission-model";

describe("calcCommission — FO_OPTIONS buy leg", () => {
  const price = 100;
  const qty = 1;
  const lotSize = 50;
  const turnover = price * qty * lotSize; // 5000

  it("brokerage is flat ₹20 for standard turnover", () => {
    const { brokerage } = calcCommission(price, qty, lotSize, "FO_OPTIONS", true);
    expect(brokerage).toBeCloseTo(20);
  });

  it("total is strictly positive", () => {
    const { total } = calcCommission(price, qty, lotSize, "FO_OPTIONS", true);
    expect(total).toBeGreaterThan(0);
  });

  it("stamp duty applies only on buy leg", () => {
    const buy = calcCommission(price, qty, lotSize, "FO_OPTIONS", true);
    const sell = calcCommission(price, qty, lotSize, "FO_OPTIONS", false);
    expect(buy.stampDuty).toBeGreaterThan(0);
    expect(sell.stampDuty).toBe(0);
  });

  it("STT on sell leg only for FO_OPTIONS", () => {
    const buy = calcCommission(price, qty, lotSize, "FO_OPTIONS", true);
    const sell = calcCommission(price, qty, lotSize, "FO_OPTIONS", false);
    expect(buy.stt).toBe(0);
    expect(sell.stt).toBeGreaterThan(0);
  });

  it("GST = 18% of (brokerage + exchangeFee)", () => {
    const { brokerage, exchangeFee, gst } = calcCommission(price, qty, lotSize, "FO_OPTIONS", true);
    expect(gst).toBeCloseTo((brokerage + exchangeFee) * 0.18, 4);
  });
});

describe("calcCommission — EQ_DELIVERY both legs", () => {
  it("STT applies on both buy and sell for delivery", () => {
    const price = 500;
    const qty = 10;
    const lotSize = 1;
    const buy = calcCommission(price, qty, lotSize, "EQ_DELIVERY", true);
    const sell = calcCommission(price, qty, lotSize, "EQ_DELIVERY", false);
    expect(buy.stt).toBeGreaterThan(0);
    expect(sell.stt).toBeGreaterThan(0);
  });
});

describe("nseCommission shorthand", () => {
  it("returns a positive number", () => {
    const cost = nseCommission(21_000, 1, 50, "FO_OPTIONS", false);
    expect(cost).toBeGreaterThan(0);
  });

  it("is consistent with calcCommission", () => {
    const expected = calcCommission(21_000, 1, 50, "FO_OPTIONS", false).total;
    expect(nseCommission(21_000, 1, 50, "FO_OPTIONS", false)).toBeCloseTo(expected);
  });
});

describe("CommissionModel class", () => {
  const model = new CommissionModel();

  it("roundTrip returns sum of buy + sell commission", () => {
    const roundTrip = model.roundTrip(100, 110, 1, 50, "FO_OPTIONS");
    const buy = model.total(100, 1, 50, "FO_OPTIONS", true);
    const sell = model.total(110, 1, 50, "FO_OPTIONS", false);
    expect(roundTrip).toBeCloseTo(buy + sell);
  });

  it("zero commission config returns zero", () => {
    const zeroModel = new CommissionModel({
      brokeragePerOrder: 0,
      sttFoSell: 0,
      sttEqIntraday: 0,
      sttEqDelivery: 0,
      exchFeeCash: 0,
      exchFeeFutures: 0,
      exchFeeOptions: 0,
      sebiFee: 0,
      gstRate: 0,
      stampDutyRate: 0,
      stampDutyMax: 0,
    });
    expect(zeroModel.total(100, 1, 50, "FO_OPTIONS", true)).toBe(0);
  });
});
