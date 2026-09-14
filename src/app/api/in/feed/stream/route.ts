import { buildFeedStream } from "@/services/india/websocket/gateway";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/feed/stream?symbols=RELIANCE,TCS&interval=5000
 *
 * Server-Sent Events stream emitting FeedDiff payloads.
 * All market data comes from data-service2.0 via the gateway.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const intervalMs = Math.max(1000, Number(searchParams.get("interval") ?? 5000));

  const stream = buildFeedStream({ symbols, intervalMs });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
