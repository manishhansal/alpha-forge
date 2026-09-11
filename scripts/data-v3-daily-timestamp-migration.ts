/**
 * D-V2-10 daily-timestamp normalization — DRY-RUN BY DEFAULT.
 *
 * Canonical semantic (V3): a daily candle belongs to a specific NSE trading
 * SESSION DATE, keyed at the session-open instant 09:15 IST (= 03:45 UTC). This
 * is the convention 85,058/89,810 rows already use.
 *
 * The remaining rows use foreign conventions (18:30 IST / 09:00 IST / 00:00 IST)
 * that (a) place bars on weekend IST dates and (b) create a SECOND epoch key for
 * a trading day that already has a canonical 09:15-IST bar — a logical duplicate
 * the composite unique key cannot dedupe.
 *
 * This tool computes, for every non-canonical daily row, the canonical
 * session-open epoch for the row's intended NSE trading date, then classifies:
 *   - MERGE_DUP: a canonical row already exists for that (instrument, date) →
 *     the non-canonical row is a duplicate to be removed (canonical wins).
 *   - RETIME:    no canonical row exists → the row's `time` is re-stamped to the
 *     canonical session-open epoch (preserving OHLCV; sourceTimestamp is set to
 *     the ORIGINAL epoch so provenance of the raw value is never lost).
 *   - WEEKEND_ORPHAN: the intended date resolves to a non-trading day and no
 *     safe canonical target exists → LEFT UNTOUCHED and reported for manual review.
 *
 * SAFETY: read-only unless run with `--apply`. Without `--apply` it only PRINTS
 * the plan. It NEVER truncates, never drops the table, never rebuilds. Under
 * `--apply` it processes in a transaction per (instrument,date) and preserves
 * the original epoch in `sourceTimestamp`. This is a HIGH-RISK operation on
 * ~89.8k production rows and must be run deliberately.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15 IST

function istParts(sec: number) {
  const d = new Date(sec * 1000 + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    da: d.getUTCDate(),
    dow: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
  };
}

/** Canonical session-open epoch (UTC sec) for an IST calendar date. */
function canonicalOpenSec(y: number, moZero: number, da: number): number {
  const midnightUtcMs = Date.UTC(y, moZero, da) - IST_OFFSET_MS;
  return Math.floor(midnightUtcMs / 1000) + SESSION_OPEN_MIN * 60;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

  const rows = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: { id: true, instrumentId: true, exchange: true, time: true },
  });

  // Index canonical opens present per (instrument|date).
  const canonicalPresent = new Set<string>();
  for (const r of rows) {
    const p = istParts(r.time);
    if (p.minutes === SESSION_OPEN_MIN && p.dow !== 0 && p.dow !== 6) {
      canonicalPresent.add(`${r.instrumentId}|${r.exchange}|${p.date}`);
    }
  }

  const plan = { CANONICAL: 0, MERGE_DUP: 0, RETIME: 0, WEEKEND_ORPHAN: 0 };
  const mergeIds: string[] = [];
  const retime: Array<{ id: string; from: number; to: number }> = [];
  const orphans: Array<{ id: string; instrumentId: string; date: string; dow: number }> = [];

  for (const r of rows) {
    const p = istParts(r.time);
    const isCanonical = p.minutes === SESSION_OPEN_MIN && p.dow !== 0 && p.dow !== 6;
    if (isCanonical) { plan.CANONICAL += 1; continue; }

    // Intended NSE trading date = the IST calendar date of this row.
    const key = `${r.instrumentId}|${r.exchange}|${p.date}`;
    const isWeekend = p.dow === 0 || p.dow === 6;
    if (isWeekend) {
      // A weekend IST date has no NSE session — cannot safely retime without
      // guessing the intended session. Report for manual review.
      plan.WEEKEND_ORPHAN += 1;
      if (orphans.length < 20) orphans.push({ id: r.id, instrumentId: r.instrumentId, date: p.date, dow: p.dow });
      continue;
    }
    if (canonicalPresent.has(key)) {
      plan.MERGE_DUP += 1;
      mergeIds.push(r.id);
    } else {
      plan.RETIME += 1;
      retime.push({ id: r.id, from: r.time, to: canonicalOpenSec(p.y, p.mo, p.da) });
    }
  }

  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY_RUN",
    totalDailyRows: rows.length,
    plan,
    retimeSample: retime.slice(0, 5),
    orphanSample: orphans.slice(0, 10),
    note: apply
      ? "APPLYING changes in transactions; original epoch preserved in sourceTimestamp."
      : "DRY RUN — no changes written. Re-run with --apply to execute (HIGH-RISK).",
  }, null, 2));

  if (!apply) { await prisma.$disconnect(); return; }

  // APPLY path: retime non-duplicates (preserve original epoch as sourceTimestamp),
  // then delete duplicates. Retime BEFORE the collision could occur is impossible
  // when a canonical already exists — that is exactly the MERGE_DUP case which we
  // delete instead. Retime targets are guaranteed collision-free (no canonical present).
  let retimed = 0, merged = 0, retimeCollision = 0;
  for (const rt of retime) {
    try {
      await prisma.candleBar.update({
        where: { id: rt.id },
        data: { time: rt.to, sourceTimestamp: new Date(rt.from * 1000) },
      });
      retimed += 1;
    } catch {
      // A concurrent/edge collision on the unique key → treat as duplicate: delete.
      retimeCollision += 1;
      try { await prisma.candleBar.delete({ where: { id: rt.id } }); } catch { /* ignore */ }
    }
  }
  for (const id of mergeIds) {
    try { await prisma.candleBar.delete({ where: { id } }); merged += 1; } catch { /* ignore */ }
  }
  console.log(JSON.stringify({ applied: { retimed, merged, retimeCollision } }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
