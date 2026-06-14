// Shared formatting helpers used across the Indian-market UI components.
// Note: `fmtCompact` uses Indian numeric notation (Cr / L / K) — distinct
// from the crypto surface which uses B / M / K via Intl compact notation.

export function fmt(n: number | null | undefined, d = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(d);
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return n.toFixed(0);
}

export function fmtPct(n: number | null | undefined, d = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

export function tone(n: number | null | undefined): "up" | "down" | "flat" {
  if (n == null || Number.isNaN(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/**
 * Round a price to the nearest NSE tick. NSE quotes (cash + F&O premiums)
 * move in 0.05 increments, so paper-trade entry / stop / target levels are
 * snapped to a valid tick before they're persisted. Pass a custom `tick`
 * (e.g. `1`) for instruments quoted in whole points. Non-finite / non-
 * positive ticks return the input untouched so callers never divide by 0.
 */
export function roundToNseTick(price: number, tick = 0.05): number {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(tick) || tick <= 0) return price;
  return Math.round(price / tick) * tick;
}
