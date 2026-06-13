import { NextResponse } from "next/server";
import { z } from "zod";

import {
  cancelIndiaOpenTrade,
  setIndiaTradeNote,
} from "@/features/india/scalping/journal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchSchema = z.object({
  note: z.string().max(2000).nullable().optional(),
  cancel: z.boolean().optional(),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/in/scalper/journal/[id]
 *
 * India mirror of the crypto patch endpoint. The underlying `cancel-`
 * and `set-note` helpers refuse to mutate a non-India row (i.e. a
 * `source` without the `in:` prefix), so even if a UI bug routes a
 * crypto id here we degrade to 404 instead of corrupting the trade.
 */
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
      {
        error: "validation failed",
        fieldErrors: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  if (parsed.data.cancel) {
    const cancelled = await cancelIndiaOpenTrade(id);
    if (!cancelled) {
      return NextResponse.json(
        { error: "trade not found, already closed, or not an India trade" },
        { status: 404 },
      );
    }
    return NextResponse.json({ item: cancelled });
  }

  if (parsed.data.note !== undefined) {
    const updated = await setIndiaTradeNote(id, parsed.data.note);
    if (!updated) {
      return NextResponse.json(
        { error: "trade not found or not an India trade" },
        { status: 404 },
      );
    }
    return NextResponse.json({ item: updated });
  }

  return NextResponse.json({ error: "no-op patch" }, { status: 400 });
}
