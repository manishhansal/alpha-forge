import { buildFeedStream } from "@/services/india/websocket/gateway";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/feed/stream?symbols=RELIANCE,TCS&interval=5000
 *
 * Server-Sent Events stream emitting `FeedDiff` payloads. Behaves like a
 * broker WebSocket: only changed symbols are sent each cycle. Replace this
 * endpoint with a real Groww feed once credentials are wired — the client
 * (`hooks/india/useFeedStream`) doesn't need to change.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Number(searchParams.get("interval") ?? 5000);

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
