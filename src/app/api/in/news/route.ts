import { NextResponse } from "next/server";
import { getIndiaNews } from "@/services/india/news";
import type { NewsCategory } from "@/types/india/news";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID_CATEGORIES = ["all", "india", "global"] as const;
type CategoryParam = (typeof VALID_CATEGORIES)[number];

function isValidCategory(v: string): v is CategoryParam {
  return (VALID_CATEGORIES as readonly string[]).includes(v);
}

/**
 * GET /api/in/news
 *
 * Query parameters:
 *   category       — "all" | "india" | "global"  (default: "all")
 *   limit          — 1–100                         (default: 40)
 *   cursor         — pagination cursor from a previous response
 *   asset_id       — filter to articles linked to a specific NSE instrument
 *   min_importance — minimum importance score [0, 1]  (default: 0)
 *   event_type     — filter by SentinelPulse event type
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const category = searchParams.get("category") ?? "all";
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 40)));
  const cursor = searchParams.get("cursor") ?? undefined;
  const asset_id = searchParams.get("asset_id") ?? undefined;
  const event_type = searchParams.get("event_type") ?? undefined;

  const rawImportance = searchParams.get("min_importance");
  const min_importance =
    rawImportance !== null ? Math.max(0, Math.min(1, Number(rawImportance))) : undefined;

  if (!isValidCategory(category)) {
    return NextResponse.json(
      { error: `Unknown category "${category}"`, valid: VALID_CATEGORIES },
      { status: 400 },
    );
  }

  try {
    const data = await getIndiaNews({
      category: category as NewsCategory | "all",
      limit,
      cursor,
      asset_id,
      min_importance,
      event_type,
    });

    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "News feed failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
