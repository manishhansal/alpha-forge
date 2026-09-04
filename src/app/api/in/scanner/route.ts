import { NextResponse } from "next/server";
import { runScanner } from "@/services/india/scanner/engine";
import type { ScannerType } from "@/types/india/scanner";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID: ScannerType[] = [
  "oi-buildup",
  "pcr",
  "iv-spike",
  "volume-breakout",
  "momentum",
  "range-expansion",
];

/** GET /api/in/scanner?type=momentum&limit=25 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const type = (searchParams.get("type") ?? "momentum") as ScannerType;
  const limit = Math.min(
    100,
    Math.max(5, Number(searchParams.get("limit") ?? 25)),
  );

  if (!VALID.includes(type)) {
    return NextResponse.json(
      { error: `Unknown scanner type "${type}"`, valid: VALID },
      { status: 400 },
    );
  }

  try {
    const result = await runScanner(type, limit);
    return NextResponse.json(result, {
      // 15s shared-cache — scanner results are identical for all users.
      // Matches the worker's 5-minute cadence but provides an intermediate
      // buffer for concurrent UI requests within the same 15s window.
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Scanner failed";
    return NextResponse.json({ error: msg, type }, { status: 502 });
  }
}
