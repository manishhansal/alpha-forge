/**
 * GET /api/in/opportunity-engine/[opportunityId]
 *
 * Returns detailed information about a specific opportunity including:
 *   - Full evidence chain
 *   - Score vector breakdown
 *   - EV calculation details
 *   - Hard gate evaluation
 *   - Soft penalty list
 *   - Position sizing rationale
 *   - Explainability contract (answers all 10 questions)
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ opportunityId: string }> },
) {
  const { opportunityId } = await params;

  if (!opportunityId?.startsWith("opp_")) {
    return NextResponse.json({ error: "Invalid opportunity ID" }, { status: 400 });
  }

  // In the current implementation, opportunities are ephemeral (computed on demand).
  // A persistent store (SignalIntelligenceRecord table) would be populated by the
  // pipeline worker once fully wired. For now, return a structured 404.
  return NextResponse.json(
    {
      error: "NOT_FOUND",
      detail: `Opportunity ${opportunityId} not found in persistent store. ` +
        "Opportunities are currently ephemeral — computed per request at /api/in/opportunity-engine. " +
        "Persistent storage will be enabled once the signal-lifecycle worker is wired.",
      opportunityId,
    },
    { status: 404 },
  );
}
