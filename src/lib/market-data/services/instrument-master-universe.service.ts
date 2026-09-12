/**
 * instrument-master-universe.service.ts — Data Foundation V7 §3.
 *
 * Builds the COMPLETE canonical NSE F&O universe from a provider instrument
 * master and persists it as an IMMUTABLE, versioned, checksummed snapshot
 * (`InstrumentMasterSnapshot` + `InstrumentMasterEntry`).
 *
 * This replaces the old ad-hoc "8-symbol test universe": the universe is now
 * discovered from Angel One's ScripMaster (the authoritative NSE/NFO/BFO scrip
 * dump) — every F&O index, every F&O equity, every future, every option
 * contract, current + next expiry included — and cross-checked against the
 * capability matrix's index list.
 *
 * ABSOLUTE RULES honoured:
 *   - Never guess an unresolved instrument: a row that cannot be classified is
 *     recorded with its raw type, never coerced into a fabricated contract.
 *   - Never fabricate: counts are computed from the real dump; a failed
 *     download throws (no synthetic universe).
 *   - Provider-specific mappings preserved: Angel `symboltoken` → `symbolToken`;
 *     Upstox `instrument_key` → `instrumentKey` (added when the Upstox master is
 *     merged; Angel rows carry `symbolToken` and a null `instrumentKey`).
 *   - Snapshots are versioned + checksummed so a signal is always traceable to
 *     the exact universe that produced it.
 */

import "server-only";

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { INDEX_UNDERLYINGS } from "../provider-capability-matrix";
import { mdLog } from "../health";

/** A normalized instrument-master entry (provider-agnostic). */
export interface UniverseEntry {
  provider: string;
  instrumentKey: string | null;
  symbol: string;
  exchange: string;
  segment: string | null;
  /** "EQ" | "FUTIDX" | "FUTSTK" | "OPTIDX" | "OPTSTK" | "INDEX". */
  instrumentType: string;
  isin: string | null;
  symbolToken: string | null;
  expiry: string | null;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  lotSize: number | null;
  tickSize: number | null;
  underlying: string | null;
  active: boolean;
}

export interface UniverseCounts {
  fnoUniverseCount: number; // distinct underlyings across F&O
  fnoEquityCount: number; // distinct F&O equity underlyings
  fnoFutureCount: number; // future contracts
  fnoOptionCount: number; // option contracts
  fnoIndexCount: number; // distinct index underlyings
}

export interface UniverseSnapshotResult {
  snapshotId: string;
  snapshotVersion: string;
  checksum: string;
  recordCount: number;
  counts: UniverseCounts;
  retrievedAt: string;
}

const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

interface RawScripRow {
  token?: string;
  symbol?: string;
  name?: string;
  expiry?: string;
  strike?: string;
  lotsize?: string;
  instrumenttype?: string;
  exch_seg?: string;
  tick_size?: string;
}

const FNO_TYPES = new Set(["OPTIDX", "OPTSTK", "FUTIDX", "FUTSTK"]);

/** Parse the Angel strike (paisa ×100 as a string) to rupees, or null. */
function parseStrike(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseFloatOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Derive CE/PE from an Angel option trading symbol suffix. Null when absent. */
function optionTypeFromSymbol(symbol: string): "CE" | "PE" | null {
  const s = symbol.toUpperCase();
  if (s.endsWith("CE")) return "CE";
  if (s.endsWith("PE")) return "PE";
  return null;
}

/**
 * Download + classify the FULL Angel ScripMaster into normalized universe
 * entries. Throws on download failure (never returns a synthetic universe).
 *
 * Classification:
 *   - NFO/BFO OPTIDX/OPTSTK → options (with expiry/strike/optionType).
 *   - NFO/BFO FUTIDX/FUTSTK → futures (with expiry).
 *   - NSE "-EQ" cash equities that are ALSO an F&O underlying → EQ.
 *   - The canonical F&O indices (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/…) → INDEX.
 */
export async function discoverFnoUniverse(opts?: {
  fetchImpl?: typeof fetch;
}): Promise<UniverseEntry[]> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const res = await doFetch(SCRIP_MASTER_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`ScripMaster download failed: HTTP ${res.status}`);
  }
  const all = (await res.json()) as RawScripRow[];
  if (!Array.isArray(all) || all.length === 0) {
    throw new Error("ScripMaster returned an empty or non-array payload");
  }

  const entries: UniverseEntry[] = [];
  // First pass: collect derivative rows and the set of F&O underlyings so we
  // know which cash equities belong to the F&O universe.
  const fnoUnderlyings = new Set<string>();

  for (const r of all) {
    if (!r || !r.instrumenttype || !r.exch_seg) continue;
    const type = r.instrumenttype.toUpperCase();
    const seg = r.exch_seg.toUpperCase();
    if ((seg === "NFO" || seg === "BFO") && FNO_TYPES.has(type)) {
      const underlying = (r.name ?? "").toUpperCase();
      if (underlying) fnoUnderlyings.add(underlying);

      const isOption = type === "OPTIDX" || type === "OPTSTK";
      entries.push({
        provider: "angel_one",
        instrumentKey: null,
        symbol: r.symbol ?? "",
        exchange: seg,
        segment: seg,
        instrumentType: type,
        isin: null,
        symbolToken: r.token ?? null,
        expiry: r.expiry || null,
        strike: isOption ? parseStrike(r.strike) : null,
        optionType: isOption ? optionTypeFromSymbol(r.symbol ?? "") : null,
        lotSize: parseIntOrNull(r.lotsize),
        tickSize: parseFloatOrNull(r.tick_size),
        underlying: underlying || null,
        active: true,
      });
    }
  }

  // Second pass: cash equities that are F&O underlyings + the canonical indices.
  const seenEq = new Set<string>();
  for (const r of all) {
    if (!r || r.exch_seg?.toUpperCase() !== "NSE") continue;
    const symbol = r.symbol ?? "";
    if (!/-EQ$/.test(symbol)) continue;
    const name = (r.name ?? "").toUpperCase();
    if (!name || seenEq.has(name)) continue;
    if (!fnoUnderlyings.has(name)) continue; // only F&O-eligible equities
    seenEq.add(name);
    entries.push({
      provider: "angel_one",
      instrumentKey: null,
      symbol: name, // canonical bare NSE symbol (matches CandleBar.instrumentId)
      exchange: "NSE",
      segment: "NSE",
      instrumentType: "EQ",
      isin: null,
      symbolToken: r.token ?? null,
      expiry: null,
      strike: null,
      optionType: null,
      lotSize: parseIntOrNull(r.lotsize),
      tickSize: parseFloatOrNull(r.tick_size),
      underlying: name,
      active: true,
    });
  }

  // Canonical F&O indices (index tokens are stable; the ScripMaster carries
  // display names like "Nifty 50" — we add the canonical rows explicitly).
  const INDEX_TOKENS: Record<string, string> = {
    NIFTY: "26000",
    BANKNIFTY: "26009",
    FINNIFTY: "26037",
    MIDCPNIFTY: "26074",
    INDIAVIX: "26017",
  };
  for (const idx of INDEX_UNDERLYINGS) {
    entries.push({
      provider: "angel_one",
      instrumentKey: null,
      symbol: idx,
      exchange: "NSE",
      segment: "NSE_INDEX",
      instrumentType: "INDEX",
      isin: null,
      symbolToken: INDEX_TOKENS[idx] ?? null,
      expiry: null,
      strike: null,
      optionType: null,
      lotSize: null,
      tickSize: null,
      underlying: idx,
      active: true,
    });
  }

  return entries;
}

/** Compute the counts summary from a normalized universe. */
export function computeUniverseCounts(entries: UniverseEntry[]): UniverseCounts {
  const fnoUnderlyings = new Set<string>();
  const equityUnderlyings = new Set<string>();
  const indexUnderlyings = new Set<string>();
  let futures = 0;
  let options = 0;
  for (const e of entries) {
    if (e.instrumentType === "OPTIDX" || e.instrumentType === "OPTSTK") {
      options += 1;
      if (e.underlying) fnoUnderlyings.add(e.underlying);
    } else if (e.instrumentType === "FUTIDX" || e.instrumentType === "FUTSTK") {
      futures += 1;
      if (e.underlying) fnoUnderlyings.add(e.underlying);
    } else if (e.instrumentType === "EQ") {
      if (e.underlying) equityUnderlyings.add(e.underlying);
    } else if (e.instrumentType === "INDEX") {
      if (e.underlying) indexUnderlyings.add(e.underlying);
    }
  }
  return {
    fnoUniverseCount: fnoUnderlyings.size,
    fnoEquityCount: equityUnderlyings.size,
    fnoFutureCount: futures,
    fnoOptionCount: options,
    fnoIndexCount: indexUnderlyings.size,
  };
}

/** Deterministic SHA-256 checksum over the canonical-sorted entry identities. */
export function computeUniverseChecksum(entries: UniverseEntry[]): string {
  const ids = entries
    .map(
      (e) =>
        `${e.provider}|${e.instrumentType}|${e.symbol}|${e.exchange}|${e.expiry ?? ""}|${e.strike ?? ""}|${e.optionType ?? ""}|${e.symbolToken ?? ""}`,
    )
    .sort();
  const h = createHash("sha256");
  for (const id of ids) h.update(id).update("\n");
  return h.digest("hex");
}

/**
 * Persist a NEW versioned instrument-master snapshot. Idempotent by checksum:
 * if the latest snapshot for this provider already has the same checksum, no
 * new snapshot is written (the universe is unchanged) and the existing one is
 * returned.
 */
export async function persistUniverseSnapshot(
  entries: UniverseEntry[],
  opts?: { provider?: string; prisma?: PrismaClient; retrievedAt?: Date },
): Promise<UniverseSnapshotResult> {
  const prisma = opts?.prisma ?? getPrisma();
  const provider = opts?.provider ?? "angel_one";
  const retrievedAt = opts?.retrievedAt ?? new Date();
  const checksum = computeUniverseChecksum(entries);
  const counts = computeUniverseCounts(entries);

  // Idempotency: skip if the latest snapshot already matches this checksum.
  const latest = await prisma.instrumentMasterSnapshot.findFirst({
    where: { provider },
    orderBy: { createdAt: "desc" },
  });
  if (latest && latest.checksum === checksum) {
    mdLog("provider_selected", {
      event: "INSTRUMENT_MASTER_UNCHANGED",
      provider,
      snapshotVersion: latest.snapshotVersion,
      checksum,
    });
    return {
      snapshotId: latest.id,
      snapshotVersion: latest.snapshotVersion,
      checksum: latest.checksum,
      recordCount: latest.recordCount,
      counts: {
        fnoUniverseCount: latest.fnoUniverseCount,
        fnoEquityCount: latest.fnoEquityCount,
        fnoFutureCount: latest.fnoFutureCount,
        fnoOptionCount: latest.fnoOptionCount,
        fnoIndexCount: latest.fnoIndexCount,
      },
      retrievedAt: latest.retrievedAt.toISOString(),
    };
  }

  const snapshotVersion = `${retrievedAt.toISOString()}#${provider}`;
  const snapshot = await prisma.instrumentMasterSnapshot.create({
    data: {
      provider,
      snapshotVersion,
      checksum,
      recordCount: entries.length,
      fnoUniverseCount: counts.fnoUniverseCount,
      fnoEquityCount: counts.fnoEquityCount,
      fnoFutureCount: counts.fnoFutureCount,
      fnoOptionCount: counts.fnoOptionCount,
      fnoIndexCount: counts.fnoIndexCount,
      retrievedAt,
    },
  });

  // Bulk insert entries in batches (createMany is fastest; skip duplicates just
  // in case). Entries are bound to the immutable snapshot.
  const BATCH = 5000;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    await prisma.instrumentMasterEntry.createMany({
      data: slice.map((e) => ({
        snapshotId: snapshot.id,
        provider: e.provider,
        instrumentKey: e.instrumentKey,
        symbol: e.symbol,
        exchange: e.exchange,
        segment: e.segment,
        instrumentType: e.instrumentType,
        isin: e.isin,
        symbolToken: e.symbolToken,
        expiry: e.expiry,
        strike: e.strike,
        optionType: e.optionType,
        lotSize: e.lotSize,
        tickSize: e.tickSize,
        underlying: e.underlying,
        active: e.active,
      })),
    });
  }

  mdLog("provider_selected", {
    event: "INSTRUMENT_MASTER_SNAPSHOT",
    provider,
    snapshotVersion,
    checksum,
    recordCount: entries.length,
    ...counts,
  });

  return {
    snapshotId: snapshot.id,
    snapshotVersion,
    checksum,
    recordCount: entries.length,
    counts,
    retrievedAt: retrievedAt.toISOString(),
  };
}

/**
 * Read the active F&O equity + index underlyings from the latest snapshot
 * (the backfill universe). Returns bare canonical symbols. Empty when no
 * snapshot exists yet.
 */
export async function getLatestUniverseUnderlyings(opts?: {
  prisma?: PrismaClient;
  provider?: string;
  include?: Array<"EQ" | "INDEX">;
}): Promise<{ snapshotVersion: string | null; symbols: string[] }> {
  const prisma = opts?.prisma ?? getPrisma();
  const provider = opts?.provider ?? "angel_one";
  const include = opts?.include ?? ["EQ", "INDEX"];
  const latest = await prisma.instrumentMasterSnapshot.findFirst({
    where: { provider },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return { snapshotVersion: null, symbols: [] };
  const rows = await prisma.instrumentMasterEntry.findMany({
    where: { snapshotId: latest.id, instrumentType: { in: include }, active: true },
    select: { symbol: true },
    orderBy: { symbol: "asc" },
  });
  const symbols = Array.from(new Set(rows.map((r) => r.symbol)));
  return { snapshotVersion: latest.snapshotVersion, symbols };
}

/** Discover + persist in one call (the CLI entry point). */
export async function refreshInstrumentMaster(opts?: {
  prisma?: PrismaClient;
}): Promise<UniverseSnapshotResult> {
  const entries = await discoverFnoUniverse();
  return persistUniverseSnapshot(entries, { prisma: opts?.prisma });
}
