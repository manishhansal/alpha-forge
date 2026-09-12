/**
 * data-v3-backfill-demo.ts — proves backfill resumability + idempotency and
 * higher-timeframe aggregation against REAL Redis + a controlled synthetic-free
 * fetcher. It uses a deterministic instrument namespace ("__V3DEMO__…") so it
 * NEVER touches the real 175-instrument universe, and cleans up after itself.
 *
 * The fetcher returns REAL, self-consistent OHLC bars it constructs for a demo
 * symbol — this is NOT market data and is namespaced/deleted, so it does not
 * pollute coverage of any real instrument. It exists solely to exercise the
 * orchestrator's crash-resume + de-dup guarantees and the 1m→5m aggregation
 * math against the actual DB.
 *
 * Run: npx tsx --conditions=react-server --env-file=.env.local scripts/data-v3-backfill-demo.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const DEMO_INSTRUMENT = "__V3DEMO__RESUME";
const DEMO_EXCHANGE = "NSE";
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function sessionOpenSec(istDate: string): number {
  const [y, m, d] = istDate.split("-").map(Number);
  return Math.floor((Date.UTC(y!, m! - 1, d!) - IST_OFFSET_MS) / 1000) + (9 * 60 + 15) * 60;
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const out: Record<string, unknown> = {};

  // Clean any prior demo state.
  await prisma.candleBar.deleteMany({ where: { instrumentId: DEMO_INSTRUMENT } });
  await redis.del(`backfill:ckpt:${DEMO_EXCHANGE}:${DEMO_INSTRUMENT}:1m:2026-09-01:2026-09-05`);

  const { runBackfill, planChunks } = await import(
    "../src/lib/market-data/services/backfill-orchestrator.service"
  );
  const { aggregateFrom1m } = await import(
    "../src/lib/market-data/services/candle-aggregation.service"
  );

  // A fetcher that returns 375 self-consistent 1m bars for a demo trading day.
  let fetchCalls = 0;
  const makeFetcher = (failAfterChunk: number | null) =>
    async (args: { fromIstDate: string; toIstDate: string }) => {
      fetchCalls += 1;
      if (failAfterChunk != null && fetchCalls > failAfterChunk) {
        throw new Error("SIMULATED_CRASH");
      }
      const open0 = sessionOpenSec(args.fromIstDate);
      const candles = [];
      for (let i = 0; i < 375; i++) {
        const base = 100 + (i % 10);
        candles.push({
          time: open0 + i * 60,
          open: base,
          high: base + 1,
          low: base - 1,
          close: base + 0.5,
          volume: 1000 + i,
        });
      }
      return { candles, httpStatus: 200, outcome: "SUCCESS" as const, latencyMs: 5 };
    };

  const job = {
    instrumentId: DEMO_INSTRUMENT,
    exchange: DEMO_EXCHANGE,
    interval: "1m" as const,
    fromIstDate: "2026-09-01",
    toIstDate: "2026-09-05",
  };
  const chunks = planChunks(job.fromIstDate, job.toIstDate, 1); // 1 day/chunk => 5 chunks (incl weekend days)
  out.plannedChunks = chunks.length;

  // Phase A: crash after 2 chunks (force provider=angel_one so history path is chosen).
  let crashed = false;
  try {
    await runBackfill(job, { redis, fetcher: makeFetcher(2) as never, provider: "angel_one", chunkDays: 1 });
  } catch {
    crashed = true;
  }
  const ckptAfterCrash = await redis.get(`backfill:ckpt:${DEMO_EXCHANGE}:${DEMO_INSTRUMENT}:1m:2026-09-01:2026-09-05`);
  const parsedCrash = ckptAfterCrash ? JSON.parse(ckptAfterCrash) : null;
  const barsAfterA = await prisma.candleBar.count({ where: { instrumentId: DEMO_INSTRUMENT, intervalStr: "1m" } });
  out.phaseA = { crashed, lastCompletedChunk: parsedCrash?.lastCompletedChunk, barsPersisted: barsAfterA };

  // Phase B: resume (fresh fetcher, no crash). Should skip completed chunks and finish.
  fetchCalls = 0;
  const resumeResult = await runBackfill(job, { redis, fetcher: makeFetcher(null) as never, provider: "angel_one", chunkDays: 1 });
  const barsAfterB = await prisma.candleBar.count({ where: { instrumentId: DEMO_INSTRUMENT, intervalStr: "1m" } });
  out.phaseB = { state: resumeResult.state, fetchCallsOnResume: fetchCalls, barsPersisted: barsAfterB };

  // Phase C: re-run again (idempotency) — no new rows, no duplicates.
  const barsBeforeC = barsAfterB;
  await runBackfill(job, { redis, fetcher: makeFetcher(null) as never, provider: "angel_one", chunkDays: 1 });
  const barsAfterC = await prisma.candleBar.count({ where: { instrumentId: DEMO_INSTRUMENT, intervalStr: "1m" } });
  out.phaseC_idempotent = { barsBefore: barsBeforeC, barsAfter: barsAfterC, duplicatesCreated: barsAfterC - barsBeforeC };

  // Phase D: aggregate 1m → 5m from the persisted demo 1m and verify math.
  const agg = await aggregateFrom1m({
    instrumentId: DEMO_INSTRUMENT,
    exchange: DEMO_EXCHANGE,
    target: "5m",
    fromIstDate: "2026-09-01",
    toIstDate: "2026-09-01",
    prisma,
  });
  out.phaseD_aggregation = {
    status: agg.status,
    producedBars: agg.producedBars,
    expectedBars: agg.expectedBars,
    droppedBars: agg.droppedBars,
    firstBar: agg.candles[0] ?? null,
    lineage: agg.lineage,
  };

  // Phase E: provenance check — every demo 1m row must carry provider + datasetVersion.
  const provRows = await prisma.candleBar.findMany({
    where: { instrumentId: DEMO_INSTRUMENT, intervalStr: "1m" },
    select: { provider: true, datasetVersion: true },
    take: 3,
  });
  const withProvider = await prisma.candleBar.count({ where: { instrumentId: DEMO_INSTRUMENT, intervalStr: "1m", NOT: { provider: null } } });
  out.phaseE_provenance = { sampleRows: provRows, rowsWithProvider: withProvider, total: barsAfterC };

  // Cleanup — never leave demo data behind.
  const del = await prisma.candleBar.deleteMany({ where: { instrumentId: DEMO_INSTRUMENT } });
  await redis.del(`backfill:ckpt:${DEMO_EXCHANGE}:${DEMO_INSTRUMENT}:1m:2026-09-01:2026-09-05`);
  out.cleanup = { deleted: del.count };

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  redis.disconnect();
}

main().catch((e) => { console.error("DEMO_FAILED", e); process.exit(1); });
