"use server";

import { revalidatePath } from "next/cache";

import { requireUserId } from "@/features/auth/session";

import {
  DELETE_INPUT_SCHEMA,
  SAVE_INPUT_SCHEMA,
  deleteApiKey,
  saveApiKey,
} from "./api-keys";

export interface ApiKeysActionResult {
  ok: boolean;
  /** Top-level error (e.g. encryption disabled, DB write failed). */
  error?: string;
  /** Per-field validation errors keyed by input name. */
  fieldErrors?: Record<string, string[]>;
}

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "readOnly") {
      // Native checkbox value is "on" / absent; allow boolean strings too.
      obj[key] = value === "on" || value === "true" || value === "1";
      continue;
    }
    obj[key] = typeof value === "string" ? value : value.name;
  }
  // When the checkbox is unchecked the field is omitted entirely; default false.
  if (!("readOnly" in obj)) obj.readOnly = false;
  return obj;
}

export async function saveApiKeyAction(
  _prev: ApiKeysActionResult | undefined,
  formData: FormData,
): Promise<ApiKeysActionResult> {
  const userId = await requireUserId();
  const parsed = SAVE_INPUT_SCHEMA.safeParse(formToObject(formData));
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  try {
    await saveApiKey(userId, parsed.data);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteApiKeyAction(
  _prev: ApiKeysActionResult | undefined,
  formData: FormData,
): Promise<ApiKeysActionResult> {
  const userId = await requireUserId();
  const parsed = DELETE_INPUT_SCHEMA.safeParse(formToObject(formData));
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  try {
    await deleteApiKey(userId, parsed.data.exchange);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath("/settings");
  return { ok: true };
}
