import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { setStrategyLive } from "@/features/strategy-lab/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  enabled: z.boolean(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to toggle live mode." },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: true, code: "INVALID_JSON", message: "Body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: true, code: "VALIDATION_ERROR", message: "Body must be { enabled: boolean }." },
      { status: 400 },
    );
  }
  const updated = await setStrategyLive(session.user.id, id, parsed.data.enabled);
  if (!updated) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: "Strategy not found." },
      { status: 404 },
    );
  }
  return NextResponse.json(updated);
}
