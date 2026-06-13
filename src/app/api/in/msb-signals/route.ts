import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/msb-signals
 *
 * Reads the MSB-OB trades CSV produced by the external Python scanner
 * (`Stocks Filter/data/msb_trades_ranked.csv`). The file is optional —
 * when it doesn't exist (e.g. running the dashboard standalone) we return
 * an empty list so the UI degrades gracefully.
 *
 * We look in a few candidate locations because the CSV lives outside the
 * Next.js project root in the original layout.
 */
export async function GET() {
  const candidates = [
    process.env.INDIA_MSB_CSV_PATH,
    path.join(process.cwd(), "data", "msb_trades_ranked.csv"),
    path.join(process.cwd(), "..", "data", "msb_trades_ranked.csv"),
    path.join(process.cwd(), "..", "..", "Stocks Filter", "data", "msb_trades_ranked.csv"),
  ].filter((p): p is string => Boolean(p));

  const file = candidates.find((c) => fs.existsSync(c));
  if (!file) return NextResponse.json([]);

  try {
    const text = fs.readFileSync(file, "utf-8");
    const rows = text.trim().split("\n");
    if (rows.length === 0) return NextResponse.json([]);

    const headers = rows[0].split(",").map((h) => h.replace(/\r/g, "").trim());
    const data = rows.slice(1).map((r) => {
      const cols = r.split(",");
      return Object.fromEntries(
        headers.map((h, i) => [h, cols[i]?.replace(/\r/g, "").trim()]),
      );
    });

    return NextResponse.json(data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[india.msb-signals] read failed:", msg);
    return NextResponse.json([]);
  }
}
