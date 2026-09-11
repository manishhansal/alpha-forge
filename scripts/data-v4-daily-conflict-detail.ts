/**
 * data-v4-daily-conflict-detail.ts — read-only. Characterises the VALUE_CONFLICT
 * duplicate pairs to find which convention (09:15 vs 18:30) is more trustworthy,
 * using magnitude of OHLC/volume difference and directionality. Evidence for the
 * normalization plan's authoritative-row rule. Writes nothing.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST = 5.5 * 3600 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15;
function istMin(sec: number) { const d = new Date(sec * 1000 + IST); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function istDate(sec: number) { const d = new Date(sec * 1000 + IST); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`; }

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const rows = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: { instrumentId: true, exchange: true, time: true, open: true, high: true, low: true, close: true, volume: true },
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.instrumentId}|${r.exchange}|${istDate(r.time)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let pairs = 0, canonHigherVol = 0, otherHigherVol = 0, sameVol = 0;
  let closeDiffSum = 0, volRatioSum = 0;
  const largeCloseDiff: unknown[] = [];
  for (const [k, g] of groups) {
    if (g.length !== 2) continue;
    const canon = g.find((r) => istMin(r.time) === SESSION_OPEN_MIN);
    const other = g.find((r) => istMin(r.time) !== SESSION_OPEN_MIN);
    if (!canon || !other) continue;
    pairs += 1;
    if (canon.volume > other.volume) canonHigherVol += 1;
    else if (canon.volume < other.volume) otherHigherVol += 1;
    else sameVol += 1;
    const cd = canon.close !== 0 ? Math.abs(canon.close - other.close) / canon.close : 0;
    closeDiffSum += cd;
    if (other.volume > 0) volRatioSum += canon.volume / other.volume;
    if (cd > 0.05 && largeCloseDiff.length < 5) largeCloseDiff.push({ k, canonClose: canon.close, otherClose: other.close, diffPct: (cd * 100).toFixed(2) });
  }
  console.log(JSON.stringify({
    conflictPairs: pairs,
    canonicalHigherVolume: canonHigherVol,
    otherHigherVolume: otherHigherVol,
    sameVolume: sameVol,
    avgAbsCloseDiffPct: pairs ? (closeDiffSum / pairs * 100).toFixed(3) : null,
    avgCanonToOtherVolRatio: pairs ? (volRatioSum / pairs).toFixed(3) : null,
    largeCloseDiffSamples: largeCloseDiff,
    interpretation: "If canonical (09:15) consistently has higher volume + small close diff, the 18:30 rows are likely earlier/partial snapshots and canonical is authoritative.",
  }, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
