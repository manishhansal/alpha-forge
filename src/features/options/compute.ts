import type { DeribitOptionInstrument } from "@/services/deribit/rest";
import type { ExpiryStats, StrikeOiBucket } from "@/types/market";

export interface InstrumentsByExpiry {
  expiryTs: number;
  calls: DeribitOptionInstrument[];
  puts: DeribitOptionInstrument[];
}

export function groupByExpiry(instruments: DeribitOptionInstrument[]): InstrumentsByExpiry[] {
  const map = new Map<number, InstrumentsByExpiry>();
  for (const inst of instruments) {
    let bucket = map.get(inst.expiryTs);
    if (!bucket) {
      bucket = { expiryTs: inst.expiryTs, calls: [], puts: [] };
      map.set(inst.expiryTs, bucket);
    }
    if (inst.optionType === "C") bucket.calls.push(inst);
    else bucket.puts.push(inst);
  }
  return [...map.values()].sort((a, b) => a.expiryTs - b.expiryTs);
}

/**
 * Max pain: the strike at which the total intrinsic value paid out by option
 * sellers (= total payout to long holders) is minimized.
 *
 * For each candidate strike S, compute:
 *   payout(S) = sum_calls( max(0, S - K_call) * OI_call )
 *             + sum_puts ( max(0, K_put - S) * OI_put )
 * Pick the strike that minimizes payout(S).
 */
export function maxPain(
  calls: DeribitOptionInstrument[],
  puts: DeribitOptionInstrument[],
): number {
  const strikes = new Set<number>();
  for (const c of calls) strikes.add(c.strike);
  for (const p of puts) strikes.add(p.strike);
  if (strikes.size === 0) return 0;

  let best = { strike: 0, payout: Infinity };
  for (const candidate of strikes) {
    let payout = 0;
    for (const c of calls) {
      if (candidate > c.strike) payout += (candidate - c.strike) * c.openInterest;
    }
    for (const p of puts) {
      if (p.strike > candidate) payout += (p.strike - candidate) * p.openInterest;
    }
    if (payout < best.payout) best = { strike: candidate, payout };
  }
  return best.strike;
}

/** Pick the option whose strike is closest to the underlying for ATM IV. */
export function atmIv(
  calls: DeribitOptionInstrument[],
  puts: DeribitOptionInstrument[],
  underlyingPrice: number,
): number {
  if (underlyingPrice <= 0) return 0;
  const candidates = [...calls, ...puts].filter((o) => o.markIv > 0);
  if (candidates.length === 0) return 0;
  let best = candidates[0];
  let bestDiff = Math.abs(candidates[0].strike - underlyingPrice);
  for (const o of candidates) {
    const d = Math.abs(o.strike - underlyingPrice);
    if (d < bestDiff) {
      best = o;
      bestDiff = d;
    }
  }
  return best.markIv;
}

export function strikeOi(
  calls: DeribitOptionInstrument[],
  puts: DeribitOptionInstrument[],
): StrikeOiBucket[] {
  const map = new Map<number, StrikeOiBucket>();
  for (const c of calls) {
    const b = map.get(c.strike) ?? { strike: c.strike, callOi: 0, putOi: 0, totalOi: 0 };
    b.callOi += c.openInterest;
    map.set(c.strike, b);
  }
  for (const p of puts) {
    const b = map.get(p.strike) ?? { strike: p.strike, callOi: 0, putOi: 0, totalOi: 0 };
    b.putOi += p.openInterest;
    map.set(p.strike, b);
  }
  for (const b of map.values()) {
    b.totalOi = b.callOi + b.putOi;
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

export function topStrikes(buckets: StrikeOiBucket[], count = 10): StrikeOiBucket[] {
  return [...buckets].sort((a, b) => b.totalOi - a.totalOi).slice(0, count);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryLabel(ts: number): string {
  const d = new Date(ts);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
  const year = String(d.getUTCFullYear()).slice(-2);
  return `${day}${month}${year}`;
}

export function buildExpiryStats(
  bucket: InstrumentsByExpiry,
  underlyingPrice: number,
): ExpiryStats {
  const callOi = sum(bucket.calls, (c) => c.openInterest);
  const putOi = sum(bucket.puts, (p) => p.openInterest);
  const callVolume = sum(bucket.calls, (c) => c.volume);
  const putVolume = sum(bucket.puts, (p) => p.volume);
  const pcrOi = callOi > 0 ? putOi / callOi : 0;
  const pcrVolume = callVolume > 0 ? putVolume / callVolume : 0;
  const buckets = strikeOi(bucket.calls, bucket.puts);
  const top = topStrikes(buckets, 10);
  return {
    expiryTs: bucket.expiryTs,
    expiryLabel: expiryLabel(bucket.expiryTs),
    daysToExpiry: Math.max(0, (bucket.expiryTs - Date.now()) / DAY_MS),
    callOi,
    putOi,
    callVolume,
    putVolume,
    pcrOi,
    pcrVolume,
    maxPainStrike: maxPain(bucket.calls, bucket.puts),
    atmIv: atmIv(bucket.calls, bucket.puts, underlyingPrice),
    topStrikes: top,
  };
}

function sum<T>(arr: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of arr) total += pick(item);
  return total;
}
