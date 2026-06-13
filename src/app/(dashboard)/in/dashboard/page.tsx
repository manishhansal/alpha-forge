"use client";

import dynamic from "next/dynamic";

// Disable SSR for the dashboard — it's a live polling client view, and
// skipping SSR also avoids hydration mismatches caused by browser extensions
// (Heurio, Grammarly, etc.) injecting into the DOM before React hydrates.
const MsbDashboard = dynamic(
  () => import("@/components/india/msb-dashboard"),
  {
    ssr: false,
    loading: () => (
      <div className="p-8 text-center text-sm text-muted-foreground">
        Loading dashboard…
      </div>
    ),
  },
);

export default function Page() {
  return <MsbDashboard />;
}
