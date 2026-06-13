import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  getStrategyLiveStats,
  listStrategyPaperTrades,
} from "@/features/strategy-lab/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to view trades." },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  const [trades, stats] = await Promise.all([
    listStrategyPaperTrades(session.user.id, id),
    getStrategyLiveStats(session.user.id, id),
  ]);
  return NextResponse.json({ trades, stats });
}
