"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Activity,
  BarChart2,
  Gauge,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import type { MarketSentiment } from "@/types/india/news";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function labelTone(label: MarketSentiment["label"]): string {
  if (label === "bullish") return "text-[var(--color-bull)]";
  if (label === "bearish") return "text-[var(--color-bear)]";
  return "text-[var(--color-fg-muted)]";
}

function regimeChip(regime: MarketSentiment["regime"]): {
  text: string;
  cls: string;
} {
  switch (regime) {
    case "risk-on":
      return {
        text: "Risk-On",
        cls: "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)] text-[var(--color-bull)]",
      };
    case "risk-off":
      return {
        text: "Risk-Off",
        cls: "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)] text-[var(--color-bear)]",
      };
    default:
      return {
        text: "Mixed",
        cls: "bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)]",
      };
  }
}

function confidenceBar(confidence: number): string {
  if (confidence >= 0.7) return "text-[var(--color-bull)]";
  if (confidence >= 0.4) return "text-[var(--color-warning)]";
  return "text-[var(--color-fg-muted)]";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function IndiaMarketSentimentBanner({
  sentiment,
}: {
  sentiment: MarketSentiment | null;
}) {
  if (!sentiment) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-[var(--color-fg-muted)]">
          Reading the tape…
        </CardContent>
      </Card>
    );
  }

  const {
    label,
    score,
    riskRatio,
    regime,
    bullCount,
    bearCount,
    headline,
    breadth,
    confidence,
  } = sentiment;

  const chip = regimeChip(regime);
  const SentimentIcon =
    label === "bullish"
      ? TrendingUp
      : label === "bearish"
        ? TrendingDown
        : Activity;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">

        {/* ── Header row ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--color-surface-hover)]">
              <SentimentIcon className={`h-5 w-5 ${labelTone(label)}`} />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Market sentiment
              </span>
              <span
                className={`text-lg font-semibold capitalize ${labelTone(label)}`}
              >
                {label}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${chip.cls}`}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              {chip.text}
            </span>
            {confidence !== null && (
              <span
                className={`inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2.5 py-1 text-[11px] font-semibold ${confidenceBar(confidence)}`}
                title="Regime confidence from SentinelPulse"
              >
                {Math.round(confidence * 100)}% conf
              </span>
            )}
          </div>
        </div>

        {/* ── Headline text ───────────────────────────────────────────────── */}
        <p className="text-sm text-[var(--color-fg-muted)]">{headline}</p>

        {/* ── Risk-appetite dial ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-[var(--color-fg-subtle)]">
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" />
              Risk appetite
            </span>
            <span className="tabular font-semibold text-[var(--color-fg)]">
              {riskRatio}/100
            </span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                background:
                  regime === "risk-off"
                    ? "var(--color-bear)"
                    : regime === "risk-on"
                      ? "var(--color-bull)"
                      : "var(--color-warning)",
              }}
              initial={{ width: 0 }}
              animate={{ width: `${riskRatio}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-[var(--color-fg-subtle)]">
            <span>Risk-off</span>
            <span>Neutral</span>
            <span>Risk-on</span>
          </div>
        </div>

        {/* ── Stats row ───────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-4 text-xs text-[var(--color-fg-muted)]">
          <span>
            Net score:{" "}
            <span className="tabular font-semibold text-[var(--color-fg)]">
              {score > 0 ? "+" : ""}
              {score}
            </span>
          </span>
          <span className="text-[var(--color-bull)]">{bullCount} bullish</span>
          <span className="text-[var(--color-bear)]">{bearCount} bearish</span>

          {/* Breadth row — only when SentinelPulse breadth data is present */}
          {breadth && (
            <>
              <span className="inline-flex items-center gap-1">
                <BarChart2 className="h-3 w-3" />
                Breadth:{" "}
                <span
                  className={`ml-0.5 font-semibold tabular ${
                    breadth.netBreadth > 0
                      ? "text-[var(--color-bull)]"
                      : breadth.netBreadth < 0
                        ? "text-[var(--color-bear)]"
                        : "text-[var(--color-fg)]"
                  }`}
                >
                  {breadth.netBreadth > 0 ? "+" : ""}
                  {(breadth.netBreadth * 100).toFixed(1)}%
                </span>
              </span>
              {breadth.highImportanceCount > 0 && (
                <span>
                  <span className="font-semibold text-[var(--color-fg)]">
                    {breadth.highImportanceCount}
                  </span>{" "}
                  high-impact
                </span>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
