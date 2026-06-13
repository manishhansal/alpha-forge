import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/session";
import { deleteAlert, updateAlert } from "@/features/alerts/queries";
import { alertUpdateSchema } from "@/features/alerts/types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, ctx: RouteContext) {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = alertUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  // Cross-field check: WEBHOOK channel requires a webhookUrl. The base partial
  // schema can't enforce this since either field could be omitted.
  if (parsed.data.channels && parsed.data.channels.includes("WEBHOOK") && !parsed.data.webhookUrl) {
    return NextResponse.json(
      { error: "webhookUrl is required when WEBHOOK channel is selected" },
      { status: 400 },
    );
  }
  const updated = await updateAlert(userId, id, parsed.data);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ item: updated });
}

export async function DELETE(_req: Request, ctx: RouteContext) {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const ok = await deleteAlert(userId, id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
