import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /in/scalper was the original combined home for the F&O preview shell.
 * The surface split into two dedicated pages — /in/strategies (live
 * signal feed + roadmap) and /in/paper-trading (open positions + journal
 * roadmap) — so the sidebar reflects the two distinct workflows. This
 * page exists only to keep old bookmarks / inbound links working via a
 * 308 permanent redirect to the new home for picking strategies.
 */
export default function LegacyIndiaScalperPage(): never {
  permanentRedirect("/in/strategies");
}
