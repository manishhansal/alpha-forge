/**
 * Phase 25 — Signal Calibration Page
 */

import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import { ResearchNav } from "@/components/research/research-nav";
import { SignalCalibrationView } from "@/components/research/signal-calibration-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Signal Calibration · Research · AlphaForge",
};

export default function SignalCalibrationPage() {
  return (
    <PageTransition>
      <div className="space-y-6 p-4 md:p-6">
        <PageHeader
          title="Signal Calibration"
          subtitle="A 70% confidence signal should win ~70% of the time. Brier Score and ECE reveal miscalibration."
        />
        <ResearchNav activeTab="signal-calibration" />
        <SignalCalibrationView />
      </div>
    </PageTransition>
  );
}
