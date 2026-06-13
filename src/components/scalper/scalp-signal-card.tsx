import { ArrowDownRight, ArrowUpRight, ShieldAlert, Sparkles, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatPercent, formatPrice } from "@/lib/utils";
import { getBrokerPair } from "@/services/brokers/shared";
import { getStrategyMeta } from "@/features/scalping/strategies/catalog";
import type { ScalpSignal } from "@/features/scalping/types";

interface Props {
  signal: ScalpSignal;
}

export function ScalpSignalCard({ signal }: Props) {
  const meta = TRACKED_SYMBOLS.find((s) => s.id === signal.symbol)!;
  const pairLabel = getBrokerPair(signal.symbol, "spot");
  const strategy = getStrategyMeta(signal.strategyId);
  const isLong = signal.direction === "LONG";
  const Icon = isLong ? ArrowUpRight : ArrowDownRight;
  const tone = isLong ? "bull" : "bear";

  return (
    <Card
      className={cn(
        "@container relative overflow-hidden ring-1 ring-inset",
        isLong
          ? "ring-[color-mix(in_oklch,var(--color-bull)_40%,transparent)]"
          : "ring-[color-mix(in_oklch,var(--color-bear)_40%,transparent)]",
      )}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${meta.color}, transparent)` }}
      />
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span
              className="grid h-9 w-9 place-items-center rounded-full text-[12px] font-semibold"
              style={{
                background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
                color: meta.color,
              }}
            >
              {signal.symbol}
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-[var(--color-fg)] text-sm">{meta.name}</CardTitle>
              <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
                {pairLabel} · {signal.timeframe}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Badge variant={tone}>
              <Icon className="h-3 w-3" />
              {signal.direction}
            </Badge>
            <Badge variant={strategy.badge} title={strategy.description} className="whitespace-nowrap">
              {strategy.label}
            </Badge>
            {signal.strategyId === "UT_SMC" ? (
              signal.confirmed ? (
                <Badge variant="info">SMC ✓</Badge>
              ) : (
                <Badge variant="outline">SMC ✗</Badge>
              )
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
            value={`$${formatPrice(signal.entry)}`}
            icon={<Sparkles className="h-3 w-3" />}
          />
          <Field
            label="Stop"
            value={`$${formatPrice(signal.stopLoss)}`}
            sub={formatPercent(((signal.stopLoss - signal.entry) / signal.entry) * 100)}
            tone={isLong ? "bear" : "bull"}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <Field
            label="Target"
            value={`$${formatPrice(signal.target)}`}
            sub={formatPercent(((signal.target - signal.entry) / signal.entry) * 100)}
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
          Triggered {new Date(signal.triggeredAt).toLocaleTimeString()} · ATR {signal.atr.toFixed(4)} · trail $
          {formatPrice(signal.trail)}
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
        <span className="num truncate text-sm font-semibold text-[var(--color-fg)]">{value}</span>
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
