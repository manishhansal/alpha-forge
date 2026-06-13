import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  deleteStrategy,
  getUserStrategy,
  updateStrategyPrompt,
} from "@/features/strategy-lab/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const symbolSchema = z.enum(["BTC", "ETH", "SOL"]);
const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  prompt: z.string().min(3).max(2000).optional(),
  symbols: z.array(symbolSchema).min(1).max(3).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to view strategy." },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  const strat = await getUserStrategy(session.user.id, id);
  if (!strat) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: "Strategy not found." },
      { status: 404 },
    );
  }
  return NextResponse.json(strat);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to edit strategies." },
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: true,
        code: "VALIDATION_ERROR",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
      { status: 400 },
    );
  }
  const updated = await updateStrategyPrompt(session.user.id, id, parsed.data);
  if (!updated) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: "Strategy not found." },
      { status: 404 },
    );
  }
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to delete strategies." },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  const ok = await deleteStrategy(session.user.id, id);
  if (!ok) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: "Strategy not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
