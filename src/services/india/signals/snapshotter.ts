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
//
// V9: All quote fetching is routed through the canonical ProviderRegistry
// (DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO). No direct yahoo import.
// DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-03: migrated.

import { FNO_STOCKS } from "@/lib/india/fno-symbols";
import { cache } from "@/services/india/cache";
import type { ProviderId } from "@/lib/market-data/types";
import { MarketDataError } from "@/lib/market-data/types";
import { classifySignal, computeScore, type SignalLabel } from "./score";

export type SignalRecord = {
  signal: SignalLabel;
  /** Unix ms when this signal first appeared (oldest unbroken observation). */
  since: number;
  /** Score at the most recent observation (handy for debugging/logs). */
  score: number;
  /**
   * Data quality classification for this snapshot entry.
   * "PROVIDER_UNAVAILABLE" means the registry returned null for this symbol
   * (no provider could supply a quote). Present on all entries written by V9+
   * snapshotter; absent on legacy cached entries.
   */
  quality?: "OK" | "PROVIDER_UNAVAILABLE";
  /**
   * The ProviderId that served the quote for this snapshot entry.
   * "UNKNOWN" when provenance is absent (served from cache or pre-V9 entries).
   */
  provider?: ProviderId | "UNKNOWN";
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
  quality: "OK" | "PROVIDER_UNAVAILABLE" = "OK",
  provider: ProviderId | "UNKNOWN" = "UNKNOWN",
): Promise<SignalRecord | null> {
  if (signal === "N/A" && quality !== "PROVIDER_UNAVAILABLE") return null;
  const key = keyFor(symbol);
  const cached = await cache.get<SignalRecord>(key);
  if (cached && cached.signal === signal && quality !== "PROVIDER_UNAVAILABLE") {
    const refreshed: SignalRecord = { ...cached, score, quality, provider };
    await cache.set(key, refreshed, SIGNAL_TTL_MS);
    return refreshed;
  }
  const fresh: SignalRecord = { signal, since: observedAt, score, quality, provider };
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

async function snapshotChunk(nseSymbols: string[]): Promise<number> {
  let stamped = 0;

  // Route through canonical registry (DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO).
  // DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-03: no direct yahoo import.
  let mdQuotes: Array<import("@/lib/market-data/types").MDQuote | null>;
  try {
    const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
    await bootstrapRegistry();
    mdQuotes = await registry.getQuotes(nseSymbols);
  } catch (e) {
    if (e instanceof MarketDataError) {
      // Req 4.3: catch MarketDataError, log at WARN, continue processing remaining symbols.
      // The entire chunk failed — write PROVIDER_UNAVAILABLE for every symbol in this chunk.
      console.warn(
        `[india-signal-snapshotter] registry.getQuotes failed for chunk (${nseSymbols.length} symbols):`,
        e.code ?? e.message,
      );
    } else {
      console.error(
        `[india-signal-snapshotter] unexpected chunk failure (${nseSymbols.length} symbols):`,
        (e as Error)?.message,
      );
    }
    // Req 4.2: write PROVIDER_UNAVAILABLE for each symbol rather than omitting them.
    for (const symbol of nseSymbols) {
      await recordSignalObservation(symbol, "N/A", 0, Date.now(), "PROVIDER_UNAVAILABLE", "UNKNOWN");
    }
    return stamped;
  }

  // Process results per symbol — never omit a symbol from the snapshot.
  for (let i = 0; i < nseSymbols.length; i++) {
    const q = mdQuotes[i];
    const symbol = nseSymbols[i]!;

    if (!q || q.ltp == null) {
      // Req 4.2: null result → write PROVIDER_UNAVAILABLE entry, never omit.
      await recordSignalObservation(symbol, "N/A", 0, Date.now(), "PROVIDER_UNAVAILABLE", "UNKNOWN");
      continue;
    }

    // Req 4.4: include provider from the MDQuote (which mirrors DataProvenance.provider).
    const provider: ProviderId | "UNKNOWN" = q.provider ?? "UNKNOWN";

    const score = computeScore({
      price: q.ltp,
      sma50: null,
      sma200: null,
      changePct: q.changePct ?? null,
      targetMean: null,
    });
    const signal = classifySignal(score);
    await recordSignalObservation(symbol, signal, score, Date.now(), "OK", provider);
    stamped++;
  }

  return stamped;
}

async function snapshotAll(): Promise<void> {
  // Use NSE symbols directly — registry.getQuotes() handles symbol → provider format
  // conversion internally. No direct yahoo import (DATA_SERVICE_PRE_REFACTOR_AUDIT.md V-03).
  const nseSymbols = [...FNO_STOCKS];
  let stamped = 0;
  for (let i = 0; i < nseSymbols.length; i += SNAPSHOT_CHUNK) {
    stamped += await snapshotChunk(nseSymbols.slice(i, i + SNAPSHOT_CHUNK));
  }
  console.log(
    `[india-signal-snapshotter] stamped ${stamped}/${nseSymbols.length} symbols`,
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
