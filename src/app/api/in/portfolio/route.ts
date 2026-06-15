import { NextResponse } from "next/server";
import { angel } from "@/services/india/angelone";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/portfolio
 *
 * Read-only Angel One broker account snapshot — funds/margin, demat holdings
 * and net positions. Each section is `null` when Angel One isn't configured (or
 * the upstream call failed), so the UI can render a "connect Angel One" empty
 * state. `connected` is true when at least one section resolved. This does NOT
 * place, modify or cancel orders.
 */
export async function GET() {
  const [funds, holdings, positions] = await Promise.all([
    angel.getFunds(),
    angel.getHoldings(),
    angel.getPositions(),
  ]);

  const connected =
    funds !== null || holdings !== null || positions !== null;

  return NextResponse.json(
    {
      connected,
      funds,
      holdings,
      positions,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
