import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/session";
import { createAlert, listAlerts } from "@/features/alerts/queries";
import { alertCreateSchema } from "@/features/alerts/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await requireUserId();
  const items = await listAlerts(userId);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const userId = await requireUserId();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = alertCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation failed", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const created = await createAlert(userId, parsed.data);
  return NextResponse.json({ item: created }, { status: 201 });
}
