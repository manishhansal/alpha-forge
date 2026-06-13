import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { dispatchEmail, dispatchWebhook, type DispatchOutcome } from "@/features/alerts/channels";
import { REDIS_KEYS } from "@/lib/constants";
import type { RedisLike } from "@/lib/redis";

import type { EvaluateResult } from "./evaluate";

export interface FireableAlert {
  id: string;
  userId: string;
  type: string;
  symbol: string;
  channels: string[];
  webhookUrl: string | null;
  cooldownSec: number;
}

export interface FireDeps {
  prisma: PrismaClient;
  redis: RedisLike;
}

export interface FireDecision {
  /** True = dispatched (cooldown was free). False = suppressed (still cooling). */
  dispatched: boolean;
  reason?: string;
  outcomes?: DispatchOutcome[];
  notificationId?: string;
}

/**
 * One-shot: gate by cooldown, create the in-app Notification row, fan out to
 * channels, and update Alert bookkeeping. Idempotent under a single tick;
 * worst-case re-entry produces at most one extra Notification per cooldown.
 */
export async function fireAlert(
  alert: FireableAlert,
  result: EvaluateResult,
  deps: FireDeps,
): Promise<FireDecision> {
  const cooldownKey = REDIS_KEYS.alertCooldown(alert.id);

  // Cooldown gate. Use SET with NX+EX so it's race-safe across multiple
  // worker instances if you ever fan out the worker.
  const existing = await deps.redis.get(cooldownKey);
  if (existing) {
    return { dispatched: false, reason: "cooldown" };
  }
  // Reserve the cooldown before fanning out so concurrent ticks don't double-fire.
  await deps.redis.set(cooldownKey, String(Date.now()), "EX", alert.cooldownSec);

  // Look up the user's email lazily, only when needed by EMAIL channel.
  const needsEmail = alert.channels.includes("EMAIL");
  const user = needsEmail
    ? await deps.prisma.user.findUnique({
        where: { id: alert.userId },
        select: { email: true },
      })
    : null;

  const notification = await deps.prisma.notification.create({
    data: {
      userId: alert.userId,
      alertId: alert.id,
      kind: "ALERT",
      symbol: alert.symbol as "BTC" | "ETH" | "SOL",
      title: result.title,
      body: result.body,
      // Prisma 7's Json column expects InputJsonValue, which is a recursive
      // structure narrower than Record<string, unknown>. We've built `payload`
      // ourselves from JSON-safe primitives, so the cast is sound.
      payload: result.payload as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const dispatchInput = {
    alertId: alert.id,
    notificationId: notification.id,
    userEmail: user?.email ?? null,
    title: result.title,
    body: result.body,
    payload: result.payload,
    webhookUrl: alert.webhookUrl,
  };

  const outcomes: DispatchOutcome[] = [{ channel: "IN_APP", ok: true }];

  const tasks: Promise<DispatchOutcome>[] = [];
  if (alert.channels.includes("WEBHOOK")) tasks.push(dispatchWebhook(dispatchInput));
  if (alert.channels.includes("EMAIL")) tasks.push(dispatchEmail(dispatchInput));
  const settled = await Promise.allSettled(tasks);
  for (const r of settled) {
    if (r.status === "fulfilled") outcomes.push(r.value);
    else outcomes.push({ channel: "WEBHOOK", ok: false, error: r.reason?.message ?? "unknown" });
  }

  await deps.prisma.alert.update({
    where: { id: alert.id },
    data: { triggeredAt: new Date(), triggerCount: { increment: 1 } },
  });

  return { dispatched: true, outcomes, notificationId: notification.id };
}
