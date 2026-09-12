/**
 * data-v6-daily-gap-redetect.ts — V6 §12 daily gap RE-detection after normalization.
 *
 * The 245 pre-existing `DataGap` rows were detected against the OLD daily
 * timestamp convention (multiple epoch keys per session, duplicate/weekend
 * artifacts). After the V6 daily normalization migration retimed every daily
 * bar to its canonical 09:15-IST session-open epoch and removed logical
 * duplicates, those gapStart epochs no longer describe reality — a "gap" may now
 * be filled by a retimed canonical bar, or its epoch is stale.
 *
 * A daily gap is a pure DETECTION ARTIFACT keyed by its session `gapStart`
 * epoch — it carries no recovered data and, pre-recovery, is fully reproducible
 * from the bars. The old rows and the re-detected rows describe the SAME missing
 * sessions, so the honest reconciliation is reset-and-redetect (NOT supersede +
 * duplicate at the same epoch, which double-counts).
 *
 * This reconciliation:
 *   1. Deletes stale daily gaps that are NOT already RECOVERED (a RECOVERED gap
 *      references a real recovered bar and is preserved). The normalization run
 *      itself is the audit record for the timestamp change (DataCorrection +
 *      TIMESTAMP_REGRESSION incidents), so no evidence is lost.
 *   2. Re-runs the calendar-aware detector over each instrument's observed daily
 *      span against the NORMALIZED bars, persisting fresh PENDING gaps.
 *   3. Prints a before/after reconciliation.
 *
 * DRY-RUN by default; --apply to write. No fabrication: a weekend/holiday/
 * pre-listing bar is never a gap (detector bounds to the NSE calendar + the
 * instrument's active period).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST = 5.5 * 3600 * 1000;
function istDate(sec: number) {
  const d = new Date(sec * 1000 + IST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { detectGaps, persistDetectedGaps } = await import(
    "../src/lib/market-data/services/gap-detection.service"
  );

  const before = {
    dailyGaps: await prisma.dataGap.count({ where: { intervalStr: "1d" } }),
    byStatus: await prisma.dataGap.groupBy({ by: ["recoveryStatus"], where: { intervalStr: "1d" }, _count: { _all: true } }),
  };

  // 1. Delete stale daily gaps that are NOT already RECOVERED. These are pure
  //    detection artifacts (no recovered data); the normalization run's
  //    DataCorrection + TIMESTAMP_REGRESSION incidents are the audit trail.
  const clearedStaleGaps = apply
    ? (await prisma.dataGap.deleteMany({
        where: { intervalStr: "1d", recoveryStatus: { notIn: ["RECOVERED"] } },
      })).count
    : before.byStatus.filter((s) => s.recoveryStatus !== "RECOVERED").reduce((n, s) => n + s._count._all, 0);

  // 2. Re-detect over the normalized daily bars for every instrument.
  const instruments = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    distinct: ["instrumentId"],
    select: { instrumentId: true, exchange: true },
  });

  let scanned = 0;
  let instrumentsWithGaps = 0;
  let freshMissingSessions = 0;
  let newRowsWritten = 0;
  const worst: Array<{ instrument: string; gaps: number; missingBars: number }> = [];

  for (const inst of instruments) {
    const span = await prisma.candleBar.aggregate({
      where: { instrumentId: inst.instrumentId, exchange: inst.exchange, intervalStr: "1d" },
      _min: { time: true },
      _max: { time: true },
    });
    if (span._min.time == null || span._max.time == null) continue;

    const result = await detectGaps({
      instrumentId: inst.instrumentId,
      exchange: inst.exchange,
      interval: "1d",
      fromIstDate: istDate(span._min.time),
      toIstDate: istDate(span._max.time),
      prisma: prisma as never,
    });
    scanned += 1;
    if (result.gaps.length > 0) {
      instrumentsWithGaps += 1;
      const missingBars = result.gaps.reduce((s, g) => s + g.missingBars, 0);
      freshMissingSessions += missingBars;
      worst.push({ instrument: inst.instrumentId, gaps: result.gaps.length, missingBars });
      if (apply) {
        newRowsWritten += await persistDetectedGaps(result, { expectedProvider: null, prisma: prisma as never });
      }
    }
  }
  worst.sort((a, b) => b.missingBars - a.missingBars);

  const after = {
    dailyGaps: await prisma.dataGap.count({ where: { intervalStr: "1d" } }),
    byStatus: await prisma.dataGap.groupBy({ by: ["recoveryStatus"], where: { intervalStr: "1d" }, _count: { _all: true } }),
  };

  console.log(
    JSON.stringify(
      {
        mode: apply ? "APPLY" : "DRY_RUN",
        before,
        clearedStalePreNormalizationGaps: clearedStaleGaps,
        redetection: {
          instrumentsScanned: scanned,
          instrumentsWithGaps,
          freshMissingSessions,
          newGapRowsWritten: newRowsWritten,
        },
        after,
        worst10: worst.slice(0, 10),
        note: "Daily-only. A recovered gap requires a CANONICAL bar that passes validation — HTTP-200 alone never resolves a gap (§12). Fresh gaps are PENDING; recovery is a credentialed provider step.",
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
