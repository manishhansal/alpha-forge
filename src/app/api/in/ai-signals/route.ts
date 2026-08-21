import { NextResponse } from "next/server";

import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/ai-signals — India F&O AI Signals feed.
 *
 * Composes a multi-confluence AI signal per F&O index + leader. Cached
 * inside the engine layer using the shared India cache facade.
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
