/**
 * Shared test fixtures.
 *
 * Tiny pure helpers that synthesise candles / tickers / futures rows so
 * every test stays self-contained and readable. Anything used in 3+
 * spec files belongs here so we don't grow N drifting copies.
 */
import type { KlineCandle } from "@/types/market";

/** Build a minimal `KlineCandle` array from a list of close prices. */
export function makeCandles(
  closes: number[],
  opts: {
    startMs?: number;
    intervalMs?: number;
    spread?: number;
    volume?: number | ((i: number) => number);
  } = {},
): KlineCandle[] {
  const startMs = opts.startMs ?? Date.UTC(2024, 0, 1);
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000; // 1h default
  const spread = opts.spread ?? 0.002;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const hi = Math.max(open, close) * (1 + spread);
    const lo = Math.min(open, close) * (1 - spread);
    const volume =
      typeof opts.volume === "function"
        ? opts.volume(i)
        : (opts.volume ?? 1_000);
    return {
      openTime: startMs + i * intervalMs,
      closeTime: startMs + (i + 1) * intervalMs - 1,
      open,
      high: hi,
      low: lo,
      close,
      volume,
    } satisfies KlineCandle;
  });
}

/** Constant-price candle series — handy for indicator warm-up tests. */
export function flatCandles(price: number, n: number): KlineCandle[] {
  return makeCandles(Array.from({ length: n }, () => price));
}

/** Linearly trending candle series. */
export function trendingCandles(start: number, step: number, n: number): KlineCandle[] {
  return makeCandles(Array.from({ length: n }, (_, i) => start + step * i));
}
