import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { listStrategyBacktests } from "@/features/strategy-lab/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to view backtests." },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  const items = await listStrategyBacktests(session.user.id, id);
  return NextResponse.json({ items });
}
