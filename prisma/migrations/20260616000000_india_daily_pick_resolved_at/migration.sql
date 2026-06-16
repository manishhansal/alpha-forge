-- Track when a Daily Pick first resolved (target hit / stopped out / squared
-- off at the close). The board shows the time-to-outcome as the gap between
-- `resolvedAt` and `generatedAt` (when the signal appeared).

-- AlterTable
ALTER TABLE "IndiaDailyPick" ADD COLUMN "resolvedAt" TIMESTAMP(3);
