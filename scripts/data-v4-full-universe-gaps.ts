/**
 * data-v4-full-universe-gaps.ts — §39 full-universe daily gap detection.
 *
 * Runs the V3 gap detector across ALL persisted instruments × the daily
 * interval over each instrument's observed span, persisting real DataGap rows.
 * No fabrication: a weekend/holiday/pre-listing bar is never a gap (the detector
 * bounds to the NSE calendar + the instrument's active period).
 *
 * NOTE on daily data quality: the daily series carries the known D-V4-02/03
 * duplicate + weekend artifacts. Duplicates INFLATE the actual-bar count, so
 * "missing" detection is conservative (a duplicated day is never reported
 * missing). This run therefore finds genuine MISSING sessions only. Intraday
 * intervals are 0-rows → skipped (reported DATA_INSUFFICIENT elsewhere, not as
 * millions of false gaps).
 *
 * Read-mostly: only writes DataGap rows for genuinely missing sessions.
 * Default caps the run; pass --all to cover every instrument.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST = 5.5 * 3600 * 1000;
function istDate(sec: number) { const d = new Date(sec * 1000 + IST); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }

async function main() {
  const all = process.argv.includes("--all");
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { detectAndPersistGaps } = await import("../src/lib/market-data/services/gap-detection.service");

  const instruments = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" }, distinct: ["instrumentId"], select: { instrumentId: true, exchange: true },
  });
  const targets = all ? instruments : instruments.slice(0, 40);

  let scanned = 0, withGaps = 0, totalGapRows = 0, noData = 0;
  const worst: Array<{ instrument: string; gaps: number; missingBars: number }> = [];

  for (const inst of targets) {
    // Bound the range to the instrument's observed span.
    const span = await prisma.candleBar.aggregate({
      where: { instrumentId: inst.instrumentId, exchange: inst.exchange, intervalStr: "1d" },
      _min: { time: true }, _max: { time: true },
    });
    if (span._min.time == null || span._max.time == null) { noData += 1; continue; }
    const { result, written } = await detectAndPersistGaps({
      instrumentId: inst.instrumentId, exchange: inst.exchange, interval: "1d",
      fromIstDate: istDate(span._min.time), toIstDate: istDate(span._max.time),
      expectedProvider: null, prisma: prisma as never,
    });
    scanned += 1;
    if (result.gaps.length > 0) {
      withGaps += 1;
      totalGapRows += written;
      const missingBars = result.gaps.reduce((s, g) => s + g.missingBars, 0);
      worst.push({ instrument: inst.instrumentId, gaps: result.gaps.length, missingBars });
    }
  }
  worst.sort((a, b) => b.missingBars - a.missingBars);

  const gapTotal = await prisma.dataGap.count();
  console.log(JSON.stringify({
    mode: all ? "ALL" : "SAMPLE_40",
    instrumentsScanned: scanned,
    instrumentsWithGaps: withGaps,
    newGapRowsWritten: totalGapRows,
    dataGapTableTotal: gapTotal,
    worst10: worst.slice(0, 10),
    note: "Daily-only. Intraday=0 rows → skipped (DATA_INSUFFICIENT, not false gaps). Duplicate days inflate actual count so missing-detection is conservative.",
  }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
