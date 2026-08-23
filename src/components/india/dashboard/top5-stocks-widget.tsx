"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useReducedMotion } from "framer-motion";
import { PanelHeader } from "@/components/trading/PanelHeader";
import { SignalBadge, type AiAction } from "@/components/trading/SignalBadge";
import { NumberMorph } from "@/components/trading/NumberMorph";
import { SPRING_GENTLE } from "@/lib/motion-presets";
import { TrendingUp, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TopPickRow } from "@/app/api/in/top-picks/route";

// ── Score bar ─────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  // score is typically –100 to +100 from the quant model
  const pct = Math.max(0, Math.min(100, (score + 100) / 2));
  const color =
    pct > 66
      ? "var(--color-data-positive)"
      : pct > 33
        ? "var(--color-data-neutral)"
        : "var(--color-data-negative)";

  return (
    <div
      role="meter"
      aria-valuenow={score}
      aria-valuemin={-100}
      aria-valuemax={100}
      aria-label={`AI score ${score}`}
      className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]"
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, backgroundColor: color, transition: "width 400ms ease" }}
      />
    </div>
  );
}

// ── Single pick card ──────────────────────────────────────────────────────

interface PickCardProps {
  pick: TopPickRow;
  index: number;
}

// Map TopPickRow signal labels to AiAction type
function toAiAction(signal: TopPickRow["signal"]): AiAction {
  if (signal === "STRONG BUY" || signal === "BUY") return "BUY";
  if (signal === "STRONG SELL" || signal === "SELL") return "SELL";
  return "WAIT";
}

function PickCard({ pick, index }: PickCardProps) {
  const reducedMotion = useReducedMotion();
  const positive = (pick.changePct ?? 0) >= 0;

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : { ...SPRING_GENTLE, delay: index * 0.07 }}
      className={cn(
        "flex flex-col gap-1 rounded-lg p-3",
        "border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]",
      )}
    >
      {/* Rank + symbol row */}
      <div className="flex items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold"
          style={{
            background: "var(--color-surface-hover)",
            color: "var(--color-fg-muted)",
            fontFamily: "var(--font-data)",
          }}
        >
          {pick.rank}
        </span>
        <span
          className="flex-1 truncate text-sm font-semibold"
          style={{ color: "var(--color-fg)", fontFamily: "var(--font-data)" }}
        >
          {pick.symbol}
        </span>
        <SignalBadge action={toAiAction(pick.signal)} size="sm" showIcon={false} />
      </div>

      {/* Sector badge */}
      <span
        className="self-start rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
        style={{
          background: "var(--color-surface-hover)",
          color: "var(--color-fg-subtle)",
          fontFamily: "var(--font-label)",
        }}
      >
        {pick.sector}
      </span>

      {/* Price + change */}
      <div className="flex items-baseline gap-2">
        {pick.price != null ? (
          <NumberMorph value={pick.price} decimals={2} className="text-sm font-medium" />
        ) : (
          <span className="text-sm text-[var(--color-fg-muted)]">—</span>
        )}
        {pick.changePct != null && (
          <span
            className="text-[11px] font-semibold tabular-nums"
            style={{
              color: positive ? "var(--color-data-positive)" : "var(--color-data-negative)",
            }}
          >
            {positive ? "+" : ""}{pick.changePct.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Score bar */}
      <ScoreBar score={pick.score} />
    </motion.div>
  );
}

// ── Widget ────────────────────────────────────────────────────────────────

interface Top5StocksWidgetProps {
  picks: TopPickRow[];
  isLoading?: boolean;
  className?: string;
}

export function Top5StocksWidget({ picks, isLoading = false, className }: Top5StocksWidgetProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-[var(--radius-panel)]",
        "border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]",
        className,
      )}
    >
      <PanelHeader
        title="Top Picks"
        icon={<Star size={14} />}
        badge={
          <span
            className="rounded px-1.5 py-0.5 text-[10px]"
            style={{ background: "var(--color-surface-hover)", color: "var(--color-fg-muted)" }}
          >
            Tomorrow
          </span>
        }
      />

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {isLoading && picks.length === 0 ? (
          // Skeleton rows
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-lg bg-[var(--color-surface)]" />
          ))
        ) : picks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <TrendingUp size={24} style={{ color: "var(--color-fg-subtle)" }} />
            <p className="text-sm" style={{ color: "var(--color-fg-muted)" }}>
              No picks available
            </p>
            <p className="text-xs" style={{ color: "var(--color-fg-subtle)" }}>
              Check back after market close
            </p>
          </div>
        ) : (
          picks.slice(0, 5).map((pick, i) => (
            <PickCard key={pick.symbol} pick={pick} index={i} />
          ))
        )}
      </div>
    </div>
  );
}
