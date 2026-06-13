import { ArrowDownRight, ArrowUpRight, ShieldAlert, Sparkles, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getIndiaStrategyMeta } from "@/features/india/scalping/strategies/catalog";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";
import { fmt, fmtPct } from "@/lib/india/format";
import { cn } from "@/lib/utils";

interface Props {
  signal: IndiaScalpSignal;
}

/**
 * India F&O scalp signal card — visual mirror of the crypto
 * `ScalpSignalCard`. Replaces the $ price formatting with ₹, the
 * Binance pair label with the NSE ticker, and the SMC confirmation
 * chip (UT_SMC-only) with the upstream scanner's kind tag (e.g.
 * "LONG_BUILDUP", "GAINER", "BULL_VOLUME") so users still get a quick
 * read on what flavour of confirmation produced the signal.
 */
export function IndiaScalpSignalCard({ signal }: Props) {
  const strategy = getIndiaStrategyMeta(signal.strategyId);
  const isLong = signal.direction === "LONG";
  const Icon = isLong ? ArrowUpRight : ArrowDownRight;
  const tone = isLong ? "bull" : "bear";
  const kindTag =
    signal.extras && typeof signal.extras.kind === "string"
      ? signal.extras.kind
      : null;
  const metricLabel =
    signal.extras && typeof signal.extras.metricLabel === "string"
      ? signal.extras.metricLabel
      : null;

  return (
    <Card
      className={cn(
        "@container relative overflow-hidden ring-1 ring-inset",
        isLong
          ? "ring-[color-mix(in_oklch,var(--color-bull)_40%,transparent)]"
          : "ring-[color-mix(in_oklch,var(--color-bear)_40%,transparent)]",
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-bg-elevated)] text-[12px] font-semibold text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border)]">
              {signal.symbol.slice(0, 4)}
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-sm text-[var(--color-fg)]">
                {signal.symbolName || signal.symbol}
              </CardTitle>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                NSE F&amp;O · {signal.timeframe}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge variant={tone}>
              <Icon className="h-3 w-3" />
              {signal.direction}
            </Badge>
            <Badge
              variant={strategy.badge}
              title={strategy.description}
              className="whitespace-nowrap"
            >
              {strategy.label}
            </Badge>
            {kindTag ? (
              <Badge variant="info" className="whitespace-nowrap text-[10px]">
                {kindTag.replace(/_/g, " ")}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
            Confidence {(signal.confidence * 100).toFixed(0)}%
          </span>
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            RR {signal.riskReward.toFixed(2)} : 1
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs @sm:grid-cols-3">
          <Field
            label="Entry"
            value={`₹${fmt(signal.entry, 2)}`}
            icon={<Sparkles className="h-3 w-3" />}
          />
          <Field
            label="Stop"
            value={`₹${fmt(signal.stopLoss, 2)}`}
            sub={fmtPct(
              ((signal.stopLoss - signal.entry) / signal.entry) * 100,
            )}
            tone={isLong ? "bear" : "bull"}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <Field
            label="Target"
            value={`₹${fmt(signal.target, 2)}`}
            sub={fmtPct(
              ((signal.target - signal.entry) / signal.entry) * 100,
            )}
            tone={isLong ? "bull" : "bear"}
            icon={<Target className="h-3 w-3" />}
          />
        </div>

        {signal.rationale.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1.5">
            {signal.rationale.map((r) => (
              <li
                key={r}
                className="flex items-start gap-2 text-[11px] text-[var(--color-fg-muted)]"
              >
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--color-fg-subtle)]" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-4 text-[10px] text-[var(--color-fg-subtle)]">
          Triggered {new Date(signal.triggeredAt).toLocaleTimeString()} ·{" "}
          {metricLabel ?? `ATR ${signal.atr.toFixed(2)}`}
        </p>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bull" | "bear";
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-1.5 @sm:flex-col @sm:items-start @sm:justify-start @sm:gap-1 @sm:py-2">
      <span className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 items-baseline gap-2 @sm:flex-col @sm:items-start @sm:gap-0.5">
        <span className="num truncate text-sm font-semibold text-[var(--color-fg)]">
          {value}
        </span>
        {sub ? (
          <span
            className={cn(
              "num shrink-0 text-[10px]",
              tone === "bull"
                ? "text-bull"
                : tone === "bear"
                  ? "text-bear"
                  : "text-[var(--color-fg-muted)]",
            )}
          >
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}
