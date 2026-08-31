/**
 * POST /api/in/whatsapp/test
 *
 * Sends a test WhatsApp message directly to the authenticated user's
 * configured phone number. Bypasses the cooldown gate — calls
 * `sendEvolutionMessage` directly rather than going through `dispatchWhatsApp`.
 *
 * Authentication: JWT session required (401 if absent).
 * Phone required: 400 if no phone is configured for the user.
 *
 * Response: { ok: boolean; message?: string }
 *   ok: true  → "Test message delivered"
 *   ok: false → error description from the Evolution API or configuration
 *
 * Requirements: 11.5
 */

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { readPhone } from "@/features/whatsapp/phone";
import { sendEvolutionMessage } from "@/features/whatsapp/notifier";
import { messageFooter } from "@/features/whatsapp/formatters/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  // ── Authentication ───────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // ── Phone lookup ─────────────────────────────────────────────────────────
  const phone = await readPhone(userId);
  if (!phone) {
    return NextResponse.json(
      { ok: false, message: "No WhatsApp phone number configured. Please add your number in Profile settings." },
      { status: 400 },
    );
  }

  // ── Build test message ───────────────────────────────────────────────────
  const footer = messageFooter();
  const testMessage = `🧪 AlphaForge Test Message\n\nYour WhatsApp notifications are working correctly!\n\n${footer}`;

  // ── Send directly — bypasses cooldown ────────────────────────────────────
  const result = await sendEvolutionMessage(phone, testMessage);

  if (result.ok) {
    return NextResponse.json({ ok: true, message: "Test message delivered" });
  }

  // Surface a meaningful error description to the caller
  const errorMessage =
    result.error ??
    (result.status ? `Evolution API returned status ${result.status}` : "Failed to deliver test message");

  return NextResponse.json({ ok: false, message: errorMessage });
}
