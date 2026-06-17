/**
 * One-shot maintenance script: wipe all India Daily Pick rows for a given
 * trading day so the next page load freezes a fresh set against the current
 * engine logic. Defaults to **today's IST date**.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/clear-india-daily-picks.ts
 *   npx tsx --env-file=.env.local scripts/clear-india-daily-picks.ts 2026-06-17
 *
 * Use this when you've shipped a change to the bucket scoring / hard-filters
 * and want to verify the new logic without waiting for tomorrow's open.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { istDateKey } from "@/features/india/daily-picks/engine";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const tradeDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)
    ? arg
    : istDateKey(new Date());

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — run with `npx tsx --env-file=.env.local …` or export it manually.",
    );
  }
  const adapter = new PrismaPg(process.env.DATABASE_URL);
  const prisma = new PrismaClient({ adapter });
  try {
    const before = await prisma.indiaDailyPick.count({ where: { tradeDate } });
    const res = await prisma.indiaDailyPick.deleteMany({ where: { tradeDate } });
    console.log(
      `[clear-india-daily-picks] tradeDate=${tradeDate} deleted=${res.count} (was ${before})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[clear-india-daily-picks] failed:", err);
  process.exitCode = 1;
});
