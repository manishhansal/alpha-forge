import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quant Research · AlphaForge",
  description: "Evidence-driven strategy research platform — leaderboard, regime matrix, Monte Carlo, parameter stability, and promotion pipeline.",
};

export default function ResearchLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
