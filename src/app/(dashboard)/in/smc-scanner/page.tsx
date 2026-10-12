import type { Metadata } from "next";
import { SMCScannerBoard } from "@/components/india/smc-scanner/smc-scanner-board";

export const metadata: Metadata = {
  title: "SMC Scanner — AlphaForge",
  description:
    "Live Smart Money Concepts scanner for NSE F&O: Order Blocks, Fair Value Gaps, Supply & Demand, Liquidity Sweeps, and Market Structure signals with entry/target/stop levels and signal timestamps.",
};

export default function SMCScannerPage() {
  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 py-6">
      <SMCScannerBoard />
    </div>
  );
}
