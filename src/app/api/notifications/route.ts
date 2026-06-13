import { NextResponse } from "next/server";

import { requireUserId } from "@/features/auth/session";
import { countUnread, listNotifications, markAllRead } from "@/features/notifications/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await requireUserId();
  const [items, unread] = await Promise.all([listNotifications(userId), countUnread(userId)]);
  return NextResponse.json({ items, unread });
}

export async function POST() {
  // POST /api/notifications  →  mark all as read.
  const userId = await requireUserId();
  const updated = await markAllRead(userId);
  return NextResponse.json({ ok: true, updated });
}
