import type { ReactNode } from "react";

import { LiveStreamMount } from "@/components/dashboard/live-stream-mount";
import { MarketTickerBar } from "@/components/dashboard/market-ticker-bar";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";
import { AuroraBackground } from "@/components/dashboard/aurora-background";
import { auth } from "@/lib/auth";
import { getActiveSelections } from "@/features/settings/active-sources";
import { pickBrokerChain } from "@/services/india/broker/factory";
import {
  dataSourceLabels,
  type DataSourceId,
} from "@/features/settings/data-sources-shared";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const user = session?.user
    ? { email: session.user.email ?? "", name: session.user.name }
    : null;
  const isAuthed = Boolean(session?.user);

  const selections = await getActiveSelections();
  const indiaSourceLabels = dataSourceLabels(
    pickBrokerChain(selections.india.selected).map(
      (b) => b.id as DataSourceId,
    ),
  );

  return (
    <div className="relative flex min-h-screen w-full bg-[var(--color-bg)] text-[var(--color-fg)]">
      {/* Animated aurora mesh — behind everything */}
      <AuroraBackground />

      <LiveStreamMount />

      {/* Sidebar */}
      <div className="relative z-10 shrink-0">
        <Sidebar isAuthed={isAuthed} indiaSourceLabels={indiaSourceLabels} />
      </div>

      {/* Main content column */}
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Topbar user={user} />
        <MarketTickerBar />
        <main className="min-w-0 flex-1 px-5 py-6">{children}</main>
      </div>
    </div>
  );
}
