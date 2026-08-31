/**
 * ExecutionModel — composes FillModel + SlippageModel + CommissionModel
 * into a single injectable component for the engine.
 *
 * This is the primary DI entry-point. Callers construct one ExecutionModel
 * with their chosen fill / slippage / commission configuration and pass it
 * to `EventEngine.setFillModel()`.
 *
 * Pre-built configurations
 * ────────────────────────
 *   ExecutionModel.realistic()  — next-bar open, 5bps slippage, NSE commission
 *   ExecutionModel.conservative() — next-bar open, 10bps slippage, NSE commission
 *   ExecutionModel.ideal()      — next-bar open, zero slippage, zero commission
 *   ExecutionModel.sameBar()    — same-bar market fill (testing only)
 */

import { NextBarOpenFillModel, MarketFillModel, LimitFillModel } from "./fill-model";
import type { FillModel } from "./fill-model";
import type { InstrumentSegment } from "./commission-model";

export type FillTiming = "NEXT_BAR_OPEN" | "SAME_BAR_CLOSE" | "LIMIT";

export interface ExecutionModelConfig {
  timing?: FillTiming;
  slippageBps?: number;
  /** Set to true to disable all slippage (useful for pure strategy testing). */
  zeroSlippage?: boolean;
  /** Set to true to disable all commission. */
  zeroCommission?: boolean;
  segment?: InstrumentSegment;
}

export function buildExecutionModel(config: ExecutionModelConfig = {}): FillModel {
  const slippageConfig = config.zeroSlippage
    ? { model: "ZERO" as const, fixedBps: 0, volumeImpactCoeff: 0, spreadFraction: 0, maxSlippageFraction: 0 }
    : { model: "FIXED_BPS" as const, fixedBps: config.slippageBps ?? 5, volumeImpactCoeff: 0.1, spreadFraction: 0.0005, maxSlippageFraction: 0.02 };

  const commissionConfig = config.zeroCommission
    ? { brokeragePerOrder: 0, sttFoSell: 0, sttEqIntraday: 0, sttEqDelivery: 0, exchFeeCash: 0, exchFeeFutures: 0, exchFeeOptions: 0, sebiFee: 0, gstRate: 0, stampDutyRate: 0, stampDutyMax: 0 }
    : {};

  const fillConfig = { slippage: slippageConfig, commission: commissionConfig, segment: config.segment ?? "FO_OPTIONS" as InstrumentSegment };

  switch (config.timing ?? "NEXT_BAR_OPEN") {
    case "NEXT_BAR_OPEN":
      return new NextBarOpenFillModel(fillConfig);
    case "SAME_BAR_CLOSE":
      return new MarketFillModel(fillConfig);
    case "LIMIT":
      return new LimitFillModel(fillConfig);
    default:
      return new NextBarOpenFillModel(fillConfig);
  }
}

/** Namespace of pre-built execution configurations. */
export const ExecutionModel = {
  /** Most realistic: next-bar open fill, 5bps slippage, full NSE commission. */
  realistic(segment?: InstrumentSegment): FillModel {
    return buildExecutionModel({ timing: "NEXT_BAR_OPEN", slippageBps: 5, segment });
  },
  /** Conservative: 10bps slippage to stress-test strategies. */
  conservative(segment?: InstrumentSegment): FillModel {
    return buildExecutionModel({ timing: "NEXT_BAR_OPEN", slippageBps: 10, segment });
  },
  /** Ideal: zero slippage, zero commission — for pure signal quality testing. */
  ideal(): FillModel {
    return buildExecutionModel({ timing: "NEXT_BAR_OPEN", zeroSlippage: true, zeroCommission: true });
  },
  /** Same-bar fill with zero costs — for unit tests only. */
  sameBar(): FillModel {
    return buildExecutionModel({ timing: "SAME_BAR_CLOSE", zeroSlippage: true, zeroCommission: true });
  },
};
