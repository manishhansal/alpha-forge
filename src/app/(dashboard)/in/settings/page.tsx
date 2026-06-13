import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * /in/settings was the NSE F&O flavour of the old standalone settings
 * page. The consolidated profile surface lives at /in/profile now, and
 * this route exists only to keep old bookmarks / inbound links working
 * via a 308 permanent redirect.
 */
export default function LegacyIndiaSettingsPage(): never {
  permanentRedirect("/in/profile");
}
