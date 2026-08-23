"use server";

import { revalidatePath } from "next/cache";

import { requireUserId } from "@/features/auth/session";
import {
  getWhatsAppPreferences,
  saveWhatsAppPreferences,
} from "@/features/whatsapp/preferences";
import { type WhatsAppPreferences } from "@/features/whatsapp/shared";
import { deletePhone, savePhone, validatePhone } from "@/features/whatsapp/phone";

// ─── Result shapes ────────────────────────────────────────────────────────────

export interface SavePhoneActionResult {
  ok: boolean;
  error?: string;
}

export interface DeletePhoneActionResult {
  ok: boolean;
  error?: string;
}

export interface SavePrefsActionResult {
  ok: boolean;
  error?: string;
}

// ─── Phone actions ────────────────────────────────────────────────────────────

/**
 * Save a validated E.164 phone number for the current user.
 *
 * Requirements: 2.1, 2.2, 2.7
 */
export async function savePhoneAction(
  _prev: SavePhoneActionResult | undefined,
  formData: FormData,
): Promise<SavePhoneActionResult> {
  const userId = await requireUserId();
  const phone = String(formData.get("phone") ?? "").trim();

  const validation = validatePhone(phone);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  try {
    await savePhone(userId, phone);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/in/profile");
  return { ok: true };
}

/**
 * Remove the stored WhatsApp phone number for the current user.
 *
 * Requirement: 2.6
 */
export async function deletePhoneAction(
  _prev: DeletePhoneActionResult | undefined,
  _formData: FormData,
): Promise<DeletePhoneActionResult> {
  const userId = await requireUserId();

  try {
    await deletePhone(userId);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/in/profile");
  return { ok: true };
}

// ─── Preferences action ───────────────────────────────────────────────────────

/**
 * Load the user's current WhatsApp preferences.
 * Returns a plain object safe to pass as a prop to a client component.
 *
 * Requirements: 3.3, 3.4
 */
export async function loadWhatsAppPrefsAction(): Promise<WhatsAppPreferences> {
  const userId = await requireUserId();
  return getWhatsAppPreferences(userId);
}

/**
 * Persist the user's WhatsApp notification preferences.
 *
 * Requirements: 3.1, 3.2, 3.5
 */
export async function saveWhatsAppPrefsAction(
  prefs: WhatsAppPreferences,
): Promise<SavePrefsActionResult> {
  const userId = await requireUserId();

  try {
    await saveWhatsAppPreferences(userId, prefs);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  revalidatePath("/in/profile");
  return { ok: true };
}
