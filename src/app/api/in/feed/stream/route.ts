import { buildFeedStream } from "@/services/india/websocket/gateway";
import { pickBrokerChain } from "@/services/india/broker/factory";
import { resolveQuotes } from "@/services/india/resolve";
import { getActiveSelections } from "@/features/settings/active-sources";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/in/feed/stream?symbols=RELIANCE,TCS&interval=5000
 *
 * Server-Sent Events stream emitting `FeedDiff` payloads. Behaves like a
 * broker WebSocket: only changed symbols are sent each cycle. The quote source
 * is the user's active India broker (e.g. Angel One SmartAPI when selected,
 * otherwise Yahoo) — the client (`hooks/india/useFeedStream`) doesn't change.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const intervalMs = Number(searchParams.get("interval") ?? 5000);

  const selections = await getActiveSelections();
  const chain = pickBrokerChain(selections.india.selected);
  const stream = buildFeedStream({
    symbols,
    intervalMs,
    fetchQuotes: (s) => resolveQuotes(chain, s).then((r) => r.quotes),
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
