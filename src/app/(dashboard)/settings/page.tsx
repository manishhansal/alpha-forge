import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /settings was the original home for account preferences, data sources,
 * API keys and alerts. Everything moved to /profile when the user-avatar
 * menu was introduced — this page exists only to keep old bookmarks /
 * inbound links working via a 308 permanent redirect.
 */
export default function LegacySettingsPage(): never {
  permanentRedirect("/profile");
}
