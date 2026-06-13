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
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Scanner failed";
    return NextResponse.json({ error: msg, type }, { status: 502 });
  }
}
