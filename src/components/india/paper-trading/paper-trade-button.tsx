"use client";

/**
 * PaperTradeButton — a single reusable button that posts a signal to
 * POST /api/in/paper-trade and shows inline feedback.
 *
 * Usage:
 *   <PaperTradeButton
 *     strategyId="DAILY_PICK"
 *     symbol="RELIANCE"
 *     direction="LONG"
 *     entry={2850}
 *     stopLoss={2800}
 *     target={2950}
 *     riskReward={2}
 *     rationale={["Strong momentum", "OI buildup"]}
 *   />
 */

import * as React from "react";
import { BookOpen, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";

export interface PaperTradePayload {
  strategyId:   IndiaScalpStrategyId;
  symbol:       string;
  symbolName?:  string;
  direction:    "LONG" | "SHORT";
  entry:        number;
  stopLoss:     number;
  target:       number;
  riskReward?:  number;
  atr?:         number | null;
  confidence?:  number;
  rationale?:   string[];
  extras?:      Record<string, unknown>;
}

type State = "idle" | "loading" | "success" | "error" | "closed";

export function PaperTradeButton({
  payload,
  size = "sm",
  className,
}: {
  payload: PaperTradePayload;
  size?:   "xs" | "sm";
  className?: string;
}) {
  const [state,   setState]   = React.useState<State>("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  const handleClick = React.useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation(); // don't bubble to row expand handler
      if (state === "loading") return;
      setState("loading");
      setMessage(null);
      try {
        const res = await fetch("/api/in/paper-trade", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(payload),
        });
        const json = await res.json() as { error?: string; opened?: boolean };
        if (!res.ok) {
          // 409 = market closed or already-open — surface the reason, not an error
          if (res.status === 409) {
            setState("closed");
            setMessage(json.error ?? "Cannot open trade");
          } else {
            setState("error");
            setMessage(json.error ?? `HTTP ${res.status}`);
          }
        } else {
          setState("success");
          setMessage("Trade opened!");
          // Auto-reset after 4 s so the button can be used again if needed
          setTimeout(() => { setState("idle"); setMessage(null); }, 4_000);
        }
      } catch (err) {
        setState("error");
        setMessage((err as Error).message);
      }
    },
    [payload, state],
  );

  const isXs = size === "xs";

  return (
    <div className={cn("relative inline-flex flex-col items-start gap-0.5", className)}>
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "loading" || state === "success"}
        title={
          state === "closed"  ? (message ?? "Market closed") :
          state === "success" ? "Paper trade opened" :
          `Paper trade — ${payload.direction} ${payload.symbol}`
        }
        className={cn(
          "inline-flex items-center gap-1 rounded-md border font-medium transition-colors",
          isXs ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
          state === "success"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : state === "error" || state === "closed"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
              : "border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-border-strong)]",
          state === "loading" && "opacity-60",
        )}
      >
        {state === "loading" ? (
          <Loader2 className={cn("animate-spin", isXs ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : state === "success" ? (
          <Check className={cn(isXs ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : state === "error" ? (
          <X className={cn(isXs ? "h-2.5 w-2.5" : "h-3 w-3")} />
        ) : (
          <BookOpen className={cn(isXs ? "h-2.5 w-2.5" : "h-3 w-3")} />
        )}
        {state === "success" ? "Opened" : state === "loading" ? "Opening…" : "Paper"}
      </button>
      {/* Inline error / closed message */}
      {(state === "error" || state === "closed") && message && (
        <span className="max-w-[180px] text-[9px] leading-tight text-rose-500 dark:text-rose-400">
          {message}
        </span>
      )}
    </div>
  );
}
