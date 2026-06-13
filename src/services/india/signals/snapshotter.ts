// Server-side "signal-since" log. The dashboard's modal asks "how long has
// this stock been STRONG BUY?" — to answer accurately regardless of when the
// user opens the page, we snapshot every F&O stock's signal label every 60s
// during market hours and persist a single per-symbol record in the shared
// cache (Redis if configured, in-memory otherwise):
//
//     signal:{SYMBOL}  →  { signal, since, score }
//
// Whenever a new observation matches the cached signal, `since` is preserved.
// A change resets `since = now`. This means clients can compute true age as
// `Date.now() - since`, even on first page-load mid-session.

import YahooFinance from "yahoo-finance2";
import { FNO_STOCKS } from "@/lib/india/fno-symbols";
import { cache } from "@/services/india/cache";
import { classifySignal, computeScore, type SignalLabel } from "./score";

const yfClient = new YahooFinance();

export type SignalRecord = {
  signal: SignalLabel;
  /** Unix ms when this signal first appeared (oldest unbroken observation). */
  since: number;
  /** Score at the most recent observation (handy for debugging/logs). */
  score: number;
};

const SIGNAL_KEY_PREFIX = "signal:";
const SIGNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SNAPSHOT_INTERVAL_MS = 60_000;
const SNAPSHOT_CHUNK = 50;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** True between 09:00 and 16:00 IST on weekdays. Slight buffer either side
 *  picks up pre-open / post-close moves. */
export function isMarketOpenIST(now: number = Date.now()): boolean {
  const ist = new Date(now + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 && minutes <= 16 * 60;
}

function keyFor(symbol: string): string {
  return `${SIGNAL_KEY_PREFIX}${symbol}`;
}

export async function recordSignalObservation(
  symbol: string,
  signal: SignalLabel,
  score: number,
  observedAt: number = Date.now(),
): Promise<SignalRecord | null> {
  if (signal === "N/A") return null;
  const key = keyFor(symbol);
  const cached = await cache.get<SignalRecord>(key);
  if (cached && cached.signal === signal) {
    const refreshed: SignalRecord = { ...cached, score };
    await cache.set(key, refreshed, SIGNAL_TTL_MS);
    return refreshed;
  }
  const fresh: SignalRecord = { signal, since: observedAt, score };
  await cache.set(key, fresh, SIGNAL_TTL_MS);
  return fresh;
}

export async function getSignalRecords(
  symbols: string[],
): Promise<Record<string, SignalRecord | null>> {
  const out: Record<string, SignalRecord | null> = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        out[s] = (await cache.get<SignalRecord>(keyFor(s))) ?? null;
      } catch {
        out[s] = null;
      }
    }),
  );
  return out;
}

interface YfSnapshotQuote {
  symbol?: string;
  regularMarketPrice?: number;
  fiftyDayAverage?: number;
  twoHundredDayAverage?: number;
  regularMarketChangePercent?: number;
  targetMeanPrice?: number;
}

async function snapshotChunk(yfSymbols: string[]): Promise<number> {
  let stamped = 0;
  try {
    const result = (await yfClient.quote(yfSymbols)) as
      | YfSnapshotQuote
      | YfSnapshotQuote[];
    const arr = Array.isArray(result) ? result : [result];
    for (const q of arr) {
      const ySym = q?.symbol;
      if (!ySym) continue;
      const symbol = ySym.replace(/\.NS$/, "");
      const price = q.regularMarketPrice ?? null;
      if (price == null) continue;

      const score = computeScore({
        price,
        sma50: q.fiftyDayAverage ?? null,
        sma200: q.twoHundredDayAverage ?? null,
        changePct: q.regularMarketChangePercent ?? null,
        targetMean: q.targetMeanPrice ?? null,
      });
      const signal = classifySignal(score);
      await recordSignalObservation(symbol, signal, score);
      stamped++;
    }
  } catch (e) {
    console.error(
      `[india-signal-snapshotter] chunk failed (${yfSymbols.length} symbols):`,
      (e as Error)?.message,
    );
  }
  return stamped;
}

async function snapshotAll(): Promise<void> {
  const yfSymbols = FNO_STOCKS.map((s) => `${s}.NS`);
  let stamped = 0;
  for (let i = 0; i < yfSymbols.length; i += SNAPSHOT_CHUNK) {
    stamped += await snapshotChunk(yfSymbols.slice(i, i + SNAPSHOT_CHUNK));
  }
  console.log(
    `[india-signal-snapshotter] stamped ${stamped}/${yfSymbols.length} symbols`,
  );
}

declare global {
   
  var __indiaSignalSnapshotterTimer:
    | ReturnType<typeof setInterval>
    | null
    | undefined;
}

export function ensureSnapshotterStarted(): void {
  if (typeof globalThis.__indiaSignalSnapshotterTimer !== "undefined") return;
  globalThis.__indiaSignalSnapshotterTimer = null;

  const tick = async () => {
    if (!isMarketOpenIST()) return;
    try {
      await snapshotAll();
    } catch (e) {
      console.error("[india-signal-snapshotter] tick failed:", e);
    }
  };

  void tick();

  globalThis.__indiaSignalSnapshotterTimer = setInterval(
    tick,
    SNAPSHOT_INTERVAL_MS,
  );
  console.log(
    `[india-signal-snapshotter] started — ticking every ${SNAPSHOT_INTERVAL_MS / 1000}s during IST market hours`,
  );
}
