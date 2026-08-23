import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";
import { dispatchWhatsApp } from "@/features/whatsapp/notifier";
import type { AiSignalEvent } from "@/features/whatsapp/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/ai-signals — India F&O AI Signals feed.
 *
 * Composes a multi-confluence AI signal per F&O index + leader. Cached
 * inside the engine layer using the shared India cache facade.
 *
 * After resolving signals, emits `AI_SIGNAL_NEW` WhatsApp notifications
 * (fire-and-forget) for every actionable signal with confidenceScore >= 60.
 *
 * Requirements: 5.1, 10.3
 */
export async function GET() {
  try {
    const data = await getIndiaAiSignals();
    // Only surface actionable directional signals — WAIT means the engine
    // found no edge. Consumers should never have to filter noise themselves.
    const actionable = {
      ...data,
      signals: data.signals.filter((s) => s.action !== "WAIT"),
    };

    // ── WhatsApp notifications (fire-and-forget) ─────────────────────────
    // Requirement 5.1: emit AI_SIGNAL_NEW for each actionable signal with
    // confidenceScore >= 60. We gate on the auth session — if the user is
    // not authenticated there is no userId to dispatch to, so we skip.
    // Requirement 10.3: dispatch must not block the response.
    const session = await auth();
    const userId = session?.user?.id;
    if (userId) {
      for (const signal of actionable.signals) {
        if (signal.confidenceScore >= 60) {
          const event: AiSignalEvent = { type: "AI_SIGNAL_NEW", signal };
          void dispatchWhatsApp(event, userId).catch((err) =>
            console.warn("[/api/in/ai-signals] whatsapp dispatch error:", err),
          );
        }
      }
    }

    return NextResponse.json(actionable, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[/api/in/ai-signals] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "INDIA_AI_SIGNALS_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
