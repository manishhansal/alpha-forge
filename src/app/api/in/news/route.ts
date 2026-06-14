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

/** GET /api/in/news?category=all&limit=40 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category") ?? "all";
  const limit = Math.min(
    100,
    Math.max(5, Number(searchParams.get("limit") ?? 40)),
  );

  if (!isValidCategory(category)) {
    return NextResponse.json(
      {
        error: `Unknown category "${category}"`,
        valid: VALID_CATEGORIES,
      },
      { status: 400 },
    );
  }

  try {
    const data = await getIndiaNews({
      category: category as NewsCategory | "all",
      limit,
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "News feed failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
