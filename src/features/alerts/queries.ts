import "server-only";

import { getPrisma } from "@/lib/prisma";

import type { AlertCreateInput, AlertUpdateInput } from "./types";

export interface AlertRow {
  id: string;
  symbol: string;
  type: string;
  threshold: number;
  comparator: string;
  channels: string[];
  webhookUrl: string | null;
  cooldownSec: number;
  active: boolean;
  triggeredAt: Date | null;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function listAlerts(userId: string): Promise<AlertRow[]> {
  const prisma = getPrisma();
  return prisma.alert.findMany({
    where: { userId },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      symbol: true,
      type: true,
      threshold: true,
      comparator: true,
      channels: true,
      webhookUrl: true,
      cooldownSec: true,
      active: true,
      triggeredAt: true,
      triggerCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function createAlert(userId: string, input: AlertCreateInput): Promise<AlertRow> {
  const prisma = getPrisma();
  return prisma.alert.create({
    data: {
      userId,
      symbol: input.symbol,
      type: input.type,
      threshold: input.threshold,
      comparator: input.comparator,
      channels: input.channels,
      webhookUrl: input.webhookUrl ?? null,
      cooldownSec: input.cooldownSec,
      active: input.active,
    },
    select: {
      id: true,
      symbol: true,
      type: true,
      threshold: true,
      comparator: true,
      channels: true,
      webhookUrl: true,
      cooldownSec: true,
      active: true,
      triggeredAt: true,
      triggerCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function updateAlert(
  userId: string,
  id: string,
  input: AlertUpdateInput,
): Promise<AlertRow | null> {
  const prisma = getPrisma();
  // updateMany so the (id, userId) tuple acts as the security filter — a
  // user can never patch another user's alert by guessing its id.
  const updated = await prisma.alert.updateMany({
    where: { id, userId },
    data: {
      ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.comparator !== undefined ? { comparator: input.comparator } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.webhookUrl !== undefined ? { webhookUrl: input.webhookUrl ?? null } : {}),
      ...(input.cooldownSec !== undefined ? { cooldownSec: input.cooldownSec } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    },
  });
  if (updated.count === 0) return null;
  return prisma.alert.findUnique({
    where: { id },
    select: {
      id: true,
      symbol: true,
      type: true,
      threshold: true,
      comparator: true,
      channels: true,
      webhookUrl: true,
      cooldownSec: true,
      active: true,
      triggeredAt: true,
      triggerCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function deleteAlert(userId: string, id: string): Promise<boolean> {
  const prisma = getPrisma();
  const res = await prisma.alert.deleteMany({ where: { id, userId } });
  return res.count > 0;
}
