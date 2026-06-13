import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  createStrategy,
  listUserStrategies,
} from "@/features/strategy-lab/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to list strategies." },
      { status: 401 },
    );
  }
  const items = await listUserStrategies(session.user.id);
  return NextResponse.json({ items });
}

const symbolSchema = z.enum(["BTC", "ETH", "SOL"]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().min(3).max(2000),
  symbols: z.array(symbolSchema).min(1).max(3),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to save a strategy." },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: true, code: "INVALID_JSON", message: "Body must be JSON." },
      { status: 400 },
    );
  }
  const parsed = createSchema.safeParse(body);
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
  try {
    const created = await createStrategy({
      userId: session.user.id,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      symbols: parsed.data.symbols,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("[/api/strategy-lab/strategies] POST error:", err);
    return NextResponse.json(
      { error: true, code: "CREATE_FAILED", message: (err as Error).message },
      { status: 500 },
    );
  }
}
