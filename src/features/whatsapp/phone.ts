import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";

import { decrypt, encrypt, type EncryptedPayload } from "@/lib/crypto";
import { getPrisma } from "@/lib/prisma";

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * E.164 phone number format: `+` followed by a non-zero leading digit and
 * 6–14 more digits (total 7–15 digits after the `+`).
 *
 * Requirement 2.7
 */
export const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Validate a phone number string against E.164 format.
 *
 * Returns `{ ok: true }` when valid, or `{ ok: false, error: string }` with
 * an inline-ready message when the input is invalid.
 *
 * Requirement 2.7
 */
export function validatePhone(phone: string): { ok: boolean; error?: string } {
  if (!phone || typeof phone !== "string") {
    return { ok: false, error: "Phone number is required." };
  }
  if (!E164_REGEX.test(phone)) {
    return {
      ok: false,
      error:
        'Phone number must be in E.164 format (e.g. +919876543210) — a "+" followed by 7–15 digits.',
    };
  }
  return { ok: true };
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt a phone number using the same AES-256-GCM path as exchange API keys.
 *
 * Requirement 2.2
 */
export function encryptPhone(phone: string): EncryptedPayload {
  return encrypt(phone);
}

// ─── Masking ─────────────────────────────────────────────────────────────────

/**
 * Return a masked display string for a stored phone number.
 *
 * The country code (everything up to and including the digits immediately
 * after `+` that form the country code) is shown in full, followed by the
 * first 5 subscriber digits, then `•••••` for the remainder.
 *
 * Examples:
 *   +919876543210  →  "+91 98765 •••••"
 *   +12025551234   →  "+1 20255 •••••"
 *   +447911123456  →  "+44 79111 •••••"
 *
 * The split point is: country-code prefix (1–3 chars) + first 5 remaining
 * digits are visible; the rest are masked.
 *
 * Requirement 2.5
 */
export function maskPhone(phone: string): string {
  if (!phone.startsWith("+")) return phone;

  const digits = phone.slice(1); // strip leading "+"

  // Determine country-code length heuristically by prefix:
  //   1 digit  → NANP (+1...)
  //   2 digits → most of Asia/Pacific/Europe/Africa
  //   3 digits → some regional codes
  // We use a simple rule: if the first digit is 1 → 1-digit CC,
  // if the first two digits form a known 2-digit CC range → 2 digits,
  // otherwise 3 digits.  For display purposes a rough heuristic is fine;
  // the spec example uses +91 (2 digits) with 5 visible subscriber digits.
  let ccLen: number;
  const firstDigit = digits[0];
  if (firstDigit === "1") {
    ccLen = 1; // NANP: +1
  } else if (digits.length >= 2) {
    // Use 2-digit CC for everything else (covers +91, +44, +49, +86, etc.)
    // 3-digit codes (+355, +358, etc.) are rare and the display is still
    // reasonable with a 2-digit assumption.
    ccLen = 2;
  } else {
    ccLen = 1;
  }

  const cc = digits.slice(0, ccLen);
  const subscriber = digits.slice(ccLen);

  const visibleLen = 5;
  const visible = subscriber.slice(0, visibleLen);
  const masked = "•".repeat(Math.max(0, subscriber.length - visibleLen));

  if (masked.length === 0) {
    // Number too short to mask anything — just show it
    return `+${cc} ${visible}`;
  }

  return `+${cc} ${visible} ${masked}`;
}

// ─── Prisma helpers ───────────────────────────────────────────────────────────

/**
 * The key within `apiKeysEncrypted` where the WhatsApp phone payload is stored.
 */
const WHATSAPP_KEY = "whatsapp";

/**
 * Parse the raw Prisma JSON column value to a plain object, matching the
 * pattern used by `src/features/settings/api-keys.ts`.
 */
function parseStoredMap(raw: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Decrypt and return the stored WhatsApp phone number for `userId`.
 *
 * Returns `null` when:
 *  - no phone is stored for the user
 *  - Prisma is unavailable (DATABASE_URL not set, connection error, etc.)
 *  - decryption fails (e.g. ENCRYPTION_KEY was rotated)
 *
 * Requirement 2.3
 */
export async function readPhone(
  userId: string,
  prisma?: PrismaClient,
): Promise<string | null> {
  try {
    const client = prisma ?? getPrisma();
    const row = await client.userSetting.findUnique({
      where: { userId },
      select: { apiKeysEncrypted: true },
    });
    const stored = parseStoredMap(row?.apiKeysEncrypted);
    const payload = stored[WHATSAPP_KEY];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    // Cast to EncryptedPayload — decrypt() will throw on malformed data
    return decrypt(payload as unknown as EncryptedPayload);
  } catch (err) {
    console.warn("[phone] readPhone failed:", (err as Error).message);
    return null;
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Encrypt `phone` and persist it to `UserSetting.apiKeysEncrypted["whatsapp"]`
 * for the given `userId`.  Merges with existing keys — does not overwrite
 * other exchange keys stored in the same column.
 *
 * Requirement 2.2
 */
export async function savePhone(
  userId: string,
  phone: string,
  prisma?: PrismaClient,
): Promise<void> {
  const client = prisma ?? getPrisma();
  const row = await client.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const current = parseStoredMap(row?.apiKeysEncrypted);
  const next = { ...current, [WHATSAPP_KEY]: encryptPhone(phone) };
  const value = next as unknown as Prisma.InputJsonValue;
  await client.userSetting.upsert({
    where: { userId },
    create: { userId, apiKeysEncrypted: value },
    update: { apiKeysEncrypted: value },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Remove the `whatsapp` key from `UserSetting.apiKeysEncrypted` for the given
 * `userId`.  All other keys in the column are preserved.  No-ops silently if
 * no phone is currently stored.
 *
 * Requirement 2.6
 */
export async function deletePhone(
  userId: string,
  prisma?: PrismaClient,
): Promise<void> {
  try {
    const client = prisma ?? getPrisma();
    const row = await client.userSetting.findUnique({
      where: { userId },
      select: { apiKeysEncrypted: true },
    });
    const current = parseStoredMap(row?.apiKeysEncrypted);
    if (!(WHATSAPP_KEY in current)) return; // nothing to delete

    const next = { ...current };
    delete next[WHATSAPP_KEY];

    const value =
      Object.keys(next).length === 0
        ? Prisma.DbNull
        : (next as unknown as Prisma.InputJsonValue);

    await client.userSetting.upsert({
      where: { userId },
      create: { userId, apiKeysEncrypted: value },
      update: { apiKeysEncrypted: value },
    });
  } catch (err) {
    console.warn("[phone] deletePhone failed:", (err as Error).message);
  }
}
