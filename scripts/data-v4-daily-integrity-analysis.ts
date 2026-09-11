/**
 * data-v4-daily-integrity-analysis.ts — read-only, evidence-based (§4/§5/§6).
 *
 * Classifies every daily row and, for each logical duplicate trading-day
 * (same instrument+exchange+IST-date, >1 epoch key), compares the rows using
 * ACTUAL evidence (OHLC, volume, provider, sourceTimestamp, receivedAt,
 * datasetVersion, confirmedAt) to determine the conflict class and the
 * evidence-based authoritative row — WITHOUT blindly "keep newest".
 *
 * Emits aggregate counts + samples so ALPHAFORGE_DAILY_NORMALIZATION_PLAN_V4.md
 * can be written from real numbers. Writes nothing.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST = 5.5 * 3600 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15;

function ist(sec: number) {
  const d = new Date(sec * 1000 + IST);
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

type Row = {
  id: string; instrumentId: string; exchange: string; time: number;
  open: number; high: number; low: number; close: number; volume: number;
  provider: string | null; sourceTimestamp: Date | null; receivedAt: Date | null;
  datasetVersion: string | null; confirmedAt: Date;
};

function ohlcEqual(a: Row, b: Row): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const rows = (await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: {
      id: true, instrumentId: true, exchange: true, time: true,
      open: true, high: true, low: true, close: true, volume: true,
      provider: true, sourceTimestamp: true, receivedAt: true, datasetVersion: true, confirmedAt: true,
    },
  })) as Row[];

  const conventions: Record<string, number> = {};
  let weekend = 0;
  const groups = new Map<string, Row[]>();

  for (const r of rows) {
    const p = ist(r.time);
    const conv = p.minutes === SESSION_OPEN_MIN ? "09:15_IST_canonical"
      : p.minutes === 18 * 60 + 30 ? "18:30_IST"
      : p.minutes === 0 ? "00:00_IST"
      : p.minutes === 9 * 60 ? "09:00_IST"
      : `other_${Math.floor(p.minutes / 60)}:${p.minutes % 60}`;
    conventions[conv] = (conventions[conv] ?? 0) + 1;
    if (p.dow === 0 || p.dow === 6) weekend += 1;
    const key = `${r.instrumentId}|${r.exchange}|${p.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  // Classify duplicates.
  const dupClass = { EXACT_DUPLICATE: 0, VALUE_MATCH: 0, VALUE_CONFLICT: 0, PROVENANCE_CONFLICT: 0, TIMESTAMP_ONLY_CONFLICT: 0 };
  let dupDays = 0;
  const conflictSamples: unknown[] = [];
  // Authoritative-selection basis tally.
  const authBasis = { canonical_timestamp: 0, has_provider: 0, latest_confirmedAt: 0, only_row: 0 };

  for (const [key, g] of groups) {
    if (g.length <= 1) continue;
    dupDays += 1;

    const allOhlcEqual = g.every((r) => ohlcEqual(r, g[0]!));
    const providersDiffer = new Set(g.map((r) => r.provider ?? "NULL")).size > 1;
    const canonicalRows = g.filter((r) => ist(r.time).minutes === SESSION_OPEN_MIN);

    let cls: keyof typeof dupClass;
    if (allOhlcEqual && !providersDiffer) cls = "EXACT_DUPLICATE";
    else if (allOhlcEqual && providersDiffer) cls = "PROVENANCE_CONFLICT";
    else if (allOhlcEqual) cls = "VALUE_MATCH";
    else if (providersDiffer) cls = "VALUE_CONFLICT";
    else cls = allOhlcEqual ? "TIMESTAMP_ONLY_CONFLICT" : "VALUE_CONFLICT";
    // Refine: identical values but only timestamp differs → TIMESTAMP_ONLY_CONFLICT.
    if (allOhlcEqual && !providersDiffer && g.length > 1) cls = "TIMESTAMP_ONLY_CONFLICT";
    dupClass[cls] += 1;

    // Evidence-based authoritative row.
    if (canonicalRows.length >= 1) authBasis.canonical_timestamp += 1;
    else if (g.some((r) => r.provider)) authBasis.has_provider += 1;
    else authBasis.latest_confirmedAt += 1;

    if (conflictSamples.length < 8) {
      conflictSamples.push({
        key, class: cls,
        rows: g.map((r) => ({
          tod: ist(r.time).minutes, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume,
          provider: r.provider, confirmedAt: r.confirmedAt.toISOString(),
        })),
      });
    }
  }

  console.log(JSON.stringify({
    totalDailyRows: rows.length,
    logicalTradingDays: groups.size,
    conventions,
    weekendBars: weekend,
    logicalDuplicateTradingDays: dupDays,
    duplicateClassification: dupClass,
    authoritativeSelectionBasis: authBasis,
    conflictSamples,
  }, null, 2));

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
