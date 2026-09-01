/**
 * Phase 25 — Regime Matrix Page
 * Strategy × Regime performance matrix with colour-coded Sharpe values.
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { RegimeMatrixView } from "@/components/research/regime-matrix-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Regime Matrix · Research · AlphaForge",
};

export default function RegimeMatrixPage() {
  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Strategy × Regime Matrix"
          subtitle="Where does each strategy have genuine edge? Where does it destroy value?"
        />
        <ResearchNav activeTab="regime-matrix" />
        <RegimeMatrixView />
      </div>
    </PageTransition>
  );
}
