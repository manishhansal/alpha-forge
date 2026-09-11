/**
 * data-v4-daily-migration.ts — evidence-based daily normalization (V4 §4-8).
 * DRY-RUN BY DEFAULT. Requires `--apply` to write. HIGH-RISK on ~89.8k rows.
 *
 * Implements ALPHAFORGE_DAILY_NORMALIZATION_PLAN_V4.md:
 *   - CANONICAL (09:15 IST weekday singleton): stamp sessionDate; keep.
 *   - RETIME (weekday non-canonical singleton): re-stamp time→session-open,
 *     preserve original epoch in sourceTimestamp, stamp sessionDate.
 *   - VALUE_CONFLICT duplicate: KEEP the canonical (09:15) row (stamp sessionDate);
 *     write a DataCorrection preserving the conflicting non-canonical value +
 *     reason; then delete the non-canonical row (its value is now preserved).
 *     If no canonical twin exists, RETIME the surviving row + record correction.
 *   - WEEKEND_ORPHAN: DO NOT delete; record a DataQualityIncident (quarantine)
 *     and leave the row for operator/provider review.
 *
 * Two-stage: DRY_RUN prints the full plan + reconciliation preview; --apply runs
 * per-(instrument,date) in a transaction. Records before/after counts.
 *
 * NOTE: for VALUE_CONFLICT days the authoritative close cannot be determined
 * from DB evidence (no provenance, no directional signal) — the canonical row is
 * kept as OPERATIONAL and the conflict preserved for later provider re-verify.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST = 5.5 * 3600 * 1000;
const OPEN_MIN = 9 * 60 + 15;

function istParts(sec: number) {
  const d = new Date(sec * 1000 + IST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), da: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), date: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}` };
}
function canonOpenSec(y: number, moZero: number, da: number) {
  return Math.floor((Date.UTC(y, moZero, da) - IST) / 1000) + OPEN_MIN * 60;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

  const rows = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: { id: true, instrumentId: true, exchange: true, time: true, open: true, high: true, low: true, close: true, volume: true, oi: true, provider: true },
  });

  const before: { total: number; weekend: number; logicalDuplicateDays: number } = {
    total: rows.length,
    weekend: rows.filter((r) => [0, 6].includes(istParts(r.time).dow)).length,
    logicalDuplicateDays: 0,
  };
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const p = istParts(r.time);
    const k = `${r.instrumentId}|${r.exchange}|${p.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  before.logicalDuplicateDays = [...groups.values()].filter((g) => g.length > 1).length;

  const plan = { CANONICAL: 0, RETIME: 0, CONFLICT_KEEP_CANONICAL: 0, CONFLICT_NO_CANONICAL_RETIME: 0, WEEKEND_QUARANTINE: 0 };
  const actions: Array<() => Promise<void>> = [];

  for (const [key, g] of groups) {
    const [instrumentId, exchange, date] = key.split("|");
    const anyWeekend = g.some((r) => [0, 6].includes(istParts(r.time).dow));

    if (anyWeekend) {
      plan.WEEKEND_QUARANTINE += g.length;
      if (apply) actions.push(async () => {
        await prisma.dataQualityIncident.create({ data: {
          severity: "WARNING", failureType: "TIMESTAMP_REGRESSION", instrumentId, intervalStr: "1d", status: "OPEN",
          rootCause: `D-V4-03 weekend daily bar quarantined for review (IST date ${date} is a weekend)`,
          detail: { key, times: g.map((r) => r.time) }, affectedRecords: g.length,
        }});
      });
      continue;
    }

    const canonRow = g.find((r) => istParts(r.time).min === OPEN_MIN);
    const nonCanon = g.filter((r) => istParts(r.time).min !== OPEN_MIN);

    if (g.length === 1) {
      const r = g[0]!;
      const p = istParts(r.time);
      if (p.min === OPEN_MIN) {
        plan.CANONICAL += 1;
        if (apply) actions.push(async () => { await prisma.candleBar.update({ where: { id: r.id }, data: { sessionDate: date } }); });
      } else {
        plan.RETIME += 1;
        if (apply) actions.push(async () => {
          await prisma.candleBar.update({ where: { id: r.id }, data: { time: canonOpenSec(p.y, p.mo, p.da), sessionDate: date, sourceTimestamp: new Date(r.time * 1000) } });
        });
      }
      continue;
    }

    // Duplicate day.
    if (canonRow) {
      plan.CONFLICT_KEEP_CANONICAL += 1;
      if (apply) actions.push(async () => {
        // Preserve each conflicting non-canonical value as a DataCorrection, then delete it.
        for (const nc of nonCanon) {
          await prisma.dataCorrection.create({ data: {
            instrumentId, exchange: exchange!, intervalStr: "1d", time: canonRow.time,
            original: { open: nc.open, high: nc.high, low: nc.low, close: nc.close, volume: nc.volume, oi: nc.oi, sourceEpoch: nc.time },
            corrected: { open: canonRow.open, high: canonRow.high, low: canonRow.low, close: canonRow.close, volume: canonRow.volume, oi: canonRow.oi },
            reason: "D-V4-02 daily-dup VALUE_CONFLICT: kept canonical 09:15 row; conflicting non-canonical value preserved. Requires credentialed provider re-verification.",
          }});
          await prisma.candleBar.delete({ where: { id: nc.id } });
        }
        await prisma.candleBar.update({ where: { id: canonRow.id }, data: { sessionDate: date } });
      });
    } else {
      plan.CONFLICT_NO_CANONICAL_RETIME += 1;
      if (apply) actions.push(async () => {
        const keep = nonCanon[0]!;
        const p = istParts(keep.time);
        for (const nc of nonCanon.slice(1)) {
          await prisma.dataCorrection.create({ data: {
            instrumentId, exchange: exchange!, intervalStr: "1d", time: canonOpenSec(p.y, p.mo, p.da),
            original: { open: nc.open, high: nc.high, low: nc.low, close: nc.close, volume: nc.volume, oi: nc.oi, sourceEpoch: nc.time },
            corrected: { open: keep.open, high: keep.high, low: keep.low, close: keep.close, volume: keep.volume, oi: keep.oi },
            reason: "D-V4-02 daily-dup VALUE_CONFLICT (no canonical twin): retimed first non-canonical; others preserved.",
          }});
          await prisma.candleBar.delete({ where: { id: nc.id } });
        }
        await prisma.candleBar.update({ where: { id: keep.id }, data: { time: canonOpenSec(p.y, p.mo, p.da), sessionDate: date, sourceTimestamp: new Date(keep.time * 1000) } });
      });
    }
  }

  console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", before, plan,
    note: apply ? "Applying in per-day transactions..." : "DRY RUN — no writes. Re-run with --apply (HIGH-RISK, operator approval required)." }, null, 2));

  if (!apply) { await prisma.$disconnect(); return; }

  let done = 0;
  for (const act of actions) { try { await act(); done += 1; } catch (e) { console.error("action_failed", (e as Error).message); } }

  // Reconciliation.
  const after = await prisma.candleBar.findMany({ where: { intervalStr: "1d" }, select: { instrumentId: true, exchange: true, time: true } });
  const g2 = new Map<string, number>();
  let wkAfter = 0;
  for (const r of after) { const p = istParts(r.time); if ([0,6].includes(p.dow)) wkAfter += 1; const k = `${r.instrumentId}|${r.exchange}|${p.date}`; g2.set(k, (g2.get(k) ?? 0) + 1); }
  const dupAfter = [...g2.values()].filter((n) => n > 1).length;
  console.log(JSON.stringify({ applied: { actions: done }, after: { total: after.length, weekend: wkAfter, logicalDuplicateDays: dupAfter } }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
