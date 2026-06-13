import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { runStrategy } from "@/features/strategy-lab/run-backtest";
import { saveBacktest } from "@/features/strategy-lab/storage";
import { STRATEGY_PERIODS } from "@/features/strategy-lab/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const symbolSchema = z.enum(["BTC", "ETH", "SOL"]);

const bodySchema = z.object({
  prompt: z.string().min(3).max(2000),
  symbol: symbolSchema,
  period: z.enum(STRATEGY_PERIODS as unknown as readonly [string, ...string[]]),
  /** Optional: link the run to a saved strategy and persist the result. */
  strategyId: z.string().min(1).max(64).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in to run backtests." },
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

  const parsed = bodySchema.safeParse(body);
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

  const input = parsed.data;
  try {
    const result = await runStrategy({
      prompt: input.prompt,
      symbol: input.symbol,
      period: input.period as (typeof STRATEGY_PERIODS)[number],
    });

    // Persist when a strategy is associated. Ad-hoc runs aren't saved so
    // users can iterate freely on the prompt without polluting their
    // backtests list.
    if (input.strategyId) {
      // Best-effort: save and continue even if it errors.
      try {
        await saveBacktest({
          strategyId: input.strategyId,
          prompt: input.prompt,
          symbol: input.symbol,
          period: input.period as (typeof STRATEGY_PERIODS)[number],
          result,
        });
      } catch (err) {
        console.warn("[/api/strategy-lab/backtest] save failed:", (err as Error).message);
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/strategy-lab/backtest] error:", err);
    return NextResponse.json(
      { error: true, code: "BACKTEST_FAILED", message: (err as Error).message },
      { status: 502 },
    );
  }
}
