import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /scalper was the original combined home for the strategy picker + live
 * signal feed + open positions + journal. The surface split into two
 * dedicated pages — /strategies (config + live signals) and
 * /paper-trading (open positions + journal + performance) — so the
 * sidebar reflects the two distinct workflows. This page exists only to
 * keep old bookmarks / inbound links working via a 308 permanent redirect
 * to the new home for picking strategies.
 */
export default function LegacyScalperPage(): never {
  permanentRedirect("/strategies");
}
