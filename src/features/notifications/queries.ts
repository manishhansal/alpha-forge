import "server-only";

import { getPrisma } from "@/lib/prisma";

export interface NotificationListItem {
  id: string;
  title: string;
  body: string;
  symbol: string | null;
  kind: string;
  readAt: Date | null;
  createdAt: Date;
  alertId: string | null;
}

const MAX_LIST = 50;

export async function listNotifications(userId: string): Promise<NotificationListItem[]> {
  const prisma = getPrisma();
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: MAX_LIST,
    select: {
      id: true,
      title: true,
      body: true,
      symbol: true,
      kind: true,
      readAt: true,
      createdAt: true,
      alertId: true,
    },
  });
  return rows.map((r) => ({ ...r, symbol: r.symbol, kind: r.kind }));
}

export async function countUnread(userId: string): Promise<number> {
  const prisma = getPrisma();
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markRead(userId: string, id: string): Promise<boolean> {
  const prisma = getPrisma();
  const res = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const prisma = getPrisma();
  const res = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}
