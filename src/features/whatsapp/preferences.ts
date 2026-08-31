import "server-only";

import { Prisma, PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import {
  WHATSAPP_EVENT_TYPES,
  type WhatsAppEventType,
  type WhatsAppPreferences,
} from "@/features/whatsapp/shared";

// ─── Re-export shared client-safe types ──────────────────────────────────────

/**
 * The five event types and preferences interface are defined in shared.ts so
 * that client components can import them without pulling in "server-only".
 * We re-export from here for backward compatibility with existing server-side
 * callers that import from preferences.ts directly.
 *
 * Requirements: 3.1
 */
export {
  WHATSAPP_EVENT_TYPES,
  type WhatsAppEventType,
  type WhatsAppPreferences,
} from "@/features/whatsapp/shared";

// ─── Internal helpers ────────────────────────────────────────────────────────

/** All five event types enabled — the default for new users (Requirement 3.4). */
const ALL_ENABLED: WhatsAppPreferences = {
  enabledEvents: [...WHATSAPP_EVENT_TYPES],
};

/**
 * Validate and extract `WhatsAppPreferences` from an arbitrary JSON value.
 * Returns the full-enabled default when the value is absent or malformed so
 * the application never crashes on an unfamiliar DB shape.
 */
function parsePreferences(raw: unknown): WhatsAppPreferences {
  if (!raw || typeof raw !== "object") return { ...ALL_ENABLED, enabledEvents: [...ALL_ENABLED.enabledEvents] };

  const r = raw as Record<string, unknown>;
  if (!r.whatsapp || typeof r.whatsapp !== "object") {
    return { ...ALL_ENABLED, enabledEvents: [...ALL_ENABLED.enabledEvents] };
  }

  const w = r.whatsapp as Record<string, unknown>;
  if (!Array.isArray(w.enabledEvents)) {
    return { ...ALL_ENABLED, enabledEvents: [...ALL_ENABLED.enabledEvents] };
  }

  // Only keep strings that are valid WhatsAppEventType values
  const validSet = new Set<string>(WHATSAPP_EVENT_TYPES);
  const enabledEvents: WhatsAppEventType[] = [];
  for (const item of w.enabledEvents) {
    if (typeof item === "string" && validSet.has(item)) {
      const type = item as WhatsAppEventType;
      if (!enabledEvents.includes(type)) {
        enabledEvents.push(type);
      }
    }
  }

  return { enabledEvents };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read the user's WhatsApp notification preferences.
 *
 * Reads `UserSetting.dataSourcesJson` and extracts the `whatsapp.enabledEvents`
 * array. Returns all five event types enabled when the key is absent or when
 * `dataSourcesJson` is null — first-time visitors get a working default out
 * of the box (Requirement 3.4).
 *
 * @param userId - The authenticated user's ID.
 * @param prisma - Optional PrismaClient override (used in tests).
 *
 * Requirements: 3.3, 3.4
 */
export async function getWhatsAppPreferences(
  userId: string,
  prisma?: PrismaClient,
): Promise<WhatsAppPreferences> {
  const client = prisma ?? getPrisma();

  const row = await client.userSetting.findUnique({
    where: { userId },
    select: { dataSourcesJson: true },
  });

  return parsePreferences(row?.dataSourcesJson ?? null);
}

/**
 * Persist the user's WhatsApp notification preferences.
 *
 * Merges the `whatsapp` key into the existing `dataSourcesJson` object without
 * overwriting other keys (e.g. `india`, `crypto` data-source selections) so
 * that changing notification preferences never alters data source settings
 * (Requirement 3.5).
 *
 * Uses `upsert` so users who have never saved any settings get a new
 * `UserSetting` row created automatically.
 *
 * @param userId - The authenticated user's ID.
 * @param prefs  - The preferences to save.
 * @param prisma - Optional PrismaClient override (used in tests).
 *
 * Requirements: 3.2, 3.5
 */
export async function saveWhatsAppPreferences(
  userId: string,
  prefs: WhatsAppPreferences,
  prisma?: PrismaClient,
): Promise<void> {
  const client = prisma ?? getPrisma();

  // Read the current column value so we can merge rather than overwrite.
  const existing = await client.userSetting.findUnique({
    where: { userId },
    select: { dataSourcesJson: true },
  });

  // Build the merged JSON object, preserving all other top-level keys.
  const current: Record<string, unknown> =
    existing?.dataSourcesJson &&
    typeof existing.dataSourcesJson === "object" &&
    !Array.isArray(existing.dataSourcesJson)
      ? (existing.dataSourcesJson as Record<string, unknown>)
      : {};

  const merged: Record<string, unknown> = {
    ...current,
    whatsapp: {
      enabledEvents: prefs.enabledEvents,
    },
  };

  await client.userSetting.upsert({
    where: { userId },
    create: {
      userId,
      dataSourcesJson: merged as unknown as Prisma.InputJsonValue,
    },
    update: {
      dataSourcesJson: merged as unknown as Prisma.InputJsonValue,
    },
  });
}
