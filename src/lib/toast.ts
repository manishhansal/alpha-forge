/**
 * toast.ts — thin wrapper around sonner's `toast` with project-specific
 * presets for signal, data-source, error, and trade events.
 *
 * Usage:
 *   import { notify } from "@/lib/toast";
 *   notify.signal("RELIANCE", "BUY", 94.2);
 *   notify.dataSource("Angel One SmartAPI");
 *   notify.error("Failed to load option chain");
 *   notify.trade("NIFTY 25000 CE", "BUY", 184.20);
 */

import { toast } from "sonner";

export const notify = {
  /** A new trading signal fired for a symbol. */
  signal(symbol: string, side: "BUY" | "SELL", strength?: number) {
    const isBuy = side === "BUY";
    toast(
      `${isBuy ? "🟢" : "🔴"} Signal: ${symbol}`,
      {
        description: strength != null
          ? `${side} · Strength ${strength.toFixed(1)}`
          : side,
        duration: 6000,
      },
    );
  },

  /** Data source became active / switched. */
  dataSource(label: string) {
    toast.info(`Live data via ${label}`, {
      description: "Market snapshot updated",
      duration: 4000,
    });
  },

  /** Generic success. */
  success(title: string, description?: string) {
    toast.success(title, { description, duration: 4000 });
  },

  /** Generic error. */
  error(title: string, description?: string) {
    toast.error(title, { description, duration: 6000 });
  },

  /** Trade / order execution confirmation. */
  trade(symbol: string, side: "BUY" | "SELL", price: number) {
    const isBuy = side === "BUY";
    toast.success(
      `${isBuy ? "📈" : "📉"} ${side} ${symbol}`,
      {
        description: `Executed at ₹${price.toFixed(2)}`,
        duration: 5000,
      },
    );
  },

  /** Paper trade logged. */
  paperTrade(symbol: string, side: "BUY" | "SELL") {
    toast(`📋 Journal: ${side} ${symbol}`, {
      description: "Added to paper trading journal",
      duration: 3000,
    });
  },
};
