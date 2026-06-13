import { NextResponse } from "next/server";
import { z } from "zod";

import { cancelOpenTrade, setTradeNote } from "@/features/scalping/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  note: z.string().max(2000).nullable().optional(),
  cancel: z.boolean().optional(),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  if (parsed.data.cancel) {
    const cancelled = await cancelOpenTrade(id);
    if (!cancelled) {
      return NextResponse.json(
        { error: "trade not found or already closed" },
        { status: 404 },
      );
    }
    return NextResponse.json({ item: cancelled });
  }

  if (parsed.data.note !== undefined) {
    const updated = await setTradeNote(id, parsed.data.note);
    if (!updated) {
      return NextResponse.json({ error: "trade not found" }, { status: 404 });
    }
    return NextResponse.json({ item: updated });
  }

  return NextResponse.json({ error: "no-op patch" }, { status: 400 });
}
