import type { ReactNode } from "react";

import { LiveStreamMount } from "@/components/dashboard/live-stream-mount";
import { MarketTickerBar } from "@/components/dashboard/market-ticker-bar";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { auth } from "@/lib/auth";
import { getActiveSelections } from "@/features/settings/active-sources";
import { pickBrokerChain } from "@/services/india/broker/factory";
import {
  dataSourceLabels,
  type DataSourceId,
} from "@/features/settings/data-sources-shared";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // The Auth.js `authorized` callback in src/lib/auth.ts + proxy.ts already
  // redirect unauthenticated users away from protected routes, so any
  // unauthenticated request that reaches this layout is browsing one of
  // the public surfaces (Overview / Heatmap, per market). We still read
  // the session here so the topbar can render the user menu without a
  // second DB lookup and the sidebar can collapse to the public nav for
  // anonymous visitors.
  const session = await auth();
  const user = session?.user
    ? { email: session.user.email ?? "", name: session.user.name }
    : null;
  const isAuthed = Boolean(session?.user);

  // Resolve the active India quote-source chain server-side so the sidebar
  // footer reflects the real provenance (primary source first).
  const selections = await getActiveSelections();
  const indiaSourceLabels = dataSourceLabels(
    pickBrokerChain(selections.india.selected).map(
      (b) => b.id as DataSourceId,
    ),
  );

  return (
    <div className="flex min-h-screen w-full bg-[var(--color-bg)] text-[var(--color-fg)]">
      <LiveStreamMount />
      <Sidebar isAuthed={isAuthed} indiaSourceLabels={indiaSourceLabels} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} />
        <MarketTickerBar />
        <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
