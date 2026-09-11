/**
 * D-V2-10 investigation (v2) — read-only, precise.
 *
 * Confirms:
 *  - the distinct IST time-of-day conventions on daily bars,
 *  - whether "weekend" bars are genuine or a decode artifact,
 *  - logical duplicates: same instrument + same IST trading date but DIFFERENT
 *    `time` (i.e. two epoch keys for one trading day due to mixed conventions),
 *    which the composite unique key does NOT dedupe,
 *  - a few concrete offending (instrument, date) examples with all their rows.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function ist(sec: number) {
  const d = new Date(sec * 1000 + IST_OFFSET_MS);
  return {
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    hhmm: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    dow: d.getUTCDay(),
  };
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const rows = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: { time: true, instrumentId: true, exchange: true },
  });

  // Group by instrument -> IST date -> list of times.
  const byInstrDate = new Map<string, Map<string, number[]>>();
  let weekendReal = 0;
  const weekendSamples: Array<{ instrumentId: string; time: number; ist: ReturnType<typeof ist> }> = [];

  for (const r of rows) {
    const i = ist(r.time);
    if (i.dow === 0 || i.dow === 6) {
      weekendReal += 1;
      if (weekendSamples.length < 8) weekendSamples.push({ instrumentId: r.instrumentId, time: r.time, ist: i });
    }
    if (!byInstrDate.has(r.instrumentId)) byInstrDate.set(r.instrumentId, new Map());
    const dm = byInstrDate.get(r.instrumentId)!;
    if (!dm.has(i.date)) dm.set(i.date, []);
    dm.get(i.date)!.push(r.time);
  }

  let logicalDupDays = 0;
  const dupSamples: Array<{ instrumentId: string; date: string; times: string[] }> = [];
  for (const [instr, dm] of byInstrDate) {
    for (const [date, times] of dm) {
      if (times.length > 1) {
        logicalDupDays += 1;
        if (dupSamples.length < 6) {
          dupSamples.push({
            instrumentId: instr,
            date,
            times: times.map((t) => `${t} (${new Date(t * 1000).toISOString()} = ${ist(t).hhmm} IST)`),
          });
        }
      }
    }
  }

  console.log(JSON.stringify({
    totalDailyRows: rows.length,
    weekendRealBars: weekendReal,
    weekendSamples,
    logicalDuplicateTradingDays: logicalDupDays,
    duplicateSamples: dupSamples,
  }, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
