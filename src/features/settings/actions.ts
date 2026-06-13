"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUserId } from "@/features/auth/session";
import { getPrisma } from "@/lib/prisma";

export interface SettingsActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

const settingsSchema = z.object({
  name: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
  defaultPair: z.enum(["BTC", "ETH", "SOL"]),
  // "system" follows the OS preference at runtime. Persisted so a user who
  // signs in on a new device gets their saved choice rather than the
  // device's default.
  theme: z.enum(["dark", "light", "system"]).default("system"),
});

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    obj[key] = typeof value === "string" ? value : value.name;
  }
  return obj;
}

export async function updateSettingsAction(
  _prev: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  const userId = await requireUserId();
  const parsed = settingsSchema.safeParse(formToObject(formData));
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { name, defaultPair, theme } = parsed.data;
  const prisma = getPrisma();
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { name: name ?? null },
      }),
      prisma.userSetting.upsert({
        where: { userId },
        create: { userId, defaultPair, theme },
        update: { defaultPair, theme },
      }),
    ]);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath("/settings");
  return { ok: true };
}
