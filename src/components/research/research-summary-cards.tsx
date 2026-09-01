"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StrategyMeta } from "@/lib/research/types";

interface ResearchSummary {
  total: number;
  statusCounts: Record<string, number>;
  hypothesisDefined: number;
  hypothesisUnvalidated: number;
  liveStrategies: number;
  paperStrategies: number;
  researchStrategies: number;
  disabledStrategies: number;
  strategies: StrategyMeta[];
}

export function ResearchSummaryCards({ summary }: { summary: ResearchSummary }) {
  const cards = [
    {
      title: "Total Strategies",
      value: summary.total,
      sub: `${summary.hypothesisDefined} with defined hypothesis`,
      color: "var(--color-accent)",
      warn: summary.hypothesisUnvalidated > 0,
      warnMsg: `${summary.hypothesisUnvalidated} UNVALIDATED`,
    },
    {
      title: "In Research",
      value: summary.researchStrategies,
      sub: "RESEARCH / BACKTEST / WF_VALIDATED",
      color: "var(--color-fg-muted)",
      warn: false,
    },
    {
      title: "Paper Trading",
      value: summary.paperStrategies,
      sub: "Active paper trade monitoring",
      color: "#22c55e",
      warn: false,
    },
    {
      title: "Live Strategies",
      value: summary.liveStrategies,
      sub: summary.liveStrategies > 0 ? "Human-approved LIVE" : "No live strategies yet",
      color: "#f59e0b",
      warn: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium" style={{ color: "var(--color-fg-muted)" }}>
              {card.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-3xl font-bold" style={{ color: card.color }}>
              {card.value}
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--color-fg-muted)" }}>
              {card.sub}
            </p>
            {card.warn && (
              <p className="mt-1 text-xs font-medium text-amber-500">
                ⚠ {card.warnMsg}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
