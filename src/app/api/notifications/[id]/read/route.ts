import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/session";
import { markRead } from "@/features/notifications/queries";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, ctx: RouteContext) {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const ok = await markRead(userId, id);
  if (!ok) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
