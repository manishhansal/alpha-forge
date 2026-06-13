import { z } from "zod";

export const COMPARATORS = ["gt", "gte", "lt", "lte"] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const ALERT_TYPES = [
  "FUNDING_SPIKE",
  "OI_BREAKOUT",
  "PRICE_BREAKOUT",
  "LIQUIDATION_SURGE",
  "SIGNAL_CHANGE",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_CHANNELS = ["IN_APP", "EMAIL", "WEBHOOK"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type AlertSymbol = (typeof SYMBOLS)[number];

// Base object (no refinement) — used directly for partial-update and as the
// foundation for the refined create schema. zod 4 doesn't let you `.partial()`
// the result of `.refine()`, so the split is required, not stylistic.
const alertBaseSchema = z.object({
  symbol: z.enum(SYMBOLS),
  type: z.enum(ALERT_TYPES),
  /**
   * Interpretation by type:
   * - FUNDING_SPIKE    → annualized funding rate, % (e.g. 50 = 50% APR)
   * - OI_BREAKOUT      → 1h OI change, % (e.g. 5 = +5% in 1h)
   * - PRICE_BREAKOUT   → spot mark price, USD (e.g. 100_000)
   * - LIQUIDATION_SURGE→ total 5-min liquidation notional, USD
   * - SIGNAL_CHANGE    → ignored (fires on any actionable signal-type change)
   */
  threshold: z.number().finite(),
  comparator: z.enum(COMPARATORS).default("gt"),
  channels: z.array(z.enum(ALERT_CHANNELS)).min(1).max(3),
  webhookUrl: z.string().url().optional().nullable(),
  cooldownSec: z.number().int().min(30).max(86_400).default(900),
  active: z.boolean().default(true),
});

export const alertCreateSchema = alertBaseSchema.refine(
  (a) => !a.channels.includes("WEBHOOK") || (a.webhookUrl && a.webhookUrl.length > 0),
  { message: "webhookUrl is required when the WEBHOOK channel is selected", path: ["webhookUrl"] },
);
export type AlertCreateInput = z.infer<typeof alertCreateSchema>;

export const alertUpdateSchema = alertBaseSchema.partial();
export type AlertUpdateInput = z.infer<typeof alertUpdateSchema>;

export function comparatorOk(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
}

export function describeComparator(c: Comparator): string {
  switch (c) {
    case "gt":
      return ">";
    case "gte":
      return "≥";
    case "lt":
      return "<";
    case "lte":
      return "≤";
  }
}

export function describeAlertType(t: AlertType): string {
  switch (t) {
    case "FUNDING_SPIKE":
      return "Funding spike";
    case "OI_BREAKOUT":
      return "OI breakout";
    case "PRICE_BREAKOUT":
      return "Price breakout";
    case "LIQUIDATION_SURGE":
      return "Liquidation surge";
    case "SIGNAL_CHANGE":
      return "Signal change";
  }
}

export function thresholdUnit(t: AlertType): string {
  switch (t) {
    case "FUNDING_SPIKE":
      return "% APR";
    case "OI_BREAKOUT":
      return "% / 1h";
    case "PRICE_BREAKOUT":
      return "USD";
    case "LIQUIDATION_SURGE":
      return "USD / 5m";
    case "SIGNAL_CHANGE":
      return "n/a";
  }
}
