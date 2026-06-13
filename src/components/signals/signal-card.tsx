import { ArrowDownRight, ArrowUpRight, Minus, ShieldAlert, Sparkles, Target } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatPercent, formatPrice } from "@/lib/utils";
import { getBrokerPair } from "@/services/brokers/shared";
import type { RiskLevel, SignalType, TradingSignal } from "@/types/market";

interface Props {
  signal: TradingSignal;
}

const TYPE_META: Record<SignalType, { tone: "bull" | "bear" | "neutral"; icon: typeof ArrowUpRight; label: string; pillBg: string; pillText: string; ring: string }> = {
  LONG: {
    tone: "bull",
    icon: ArrowUpRight,
    label: "Long (Perp)",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bull)_18%,transparent)]",
    pillText: "text-[var(--color-bull)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_40%,transparent)]",
  },
  BUY: {
    tone: "bull",
    icon: ArrowUpRight,
    label: "Buy (Spot)",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bull)_12%,transparent)]",
    pillText: "text-[var(--color-bull)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]",
  },
  SHORT: {
    tone: "bear",
    icon: ArrowDownRight,
    label: "Short (Perp)",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bear)_18%,transparent)]",
    pillText: "text-[var(--color-bear)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_40%,transparent)]",
  },
  SELL: {
    tone: "bear",
    icon: ArrowDownRight,
    label: "Sell (Spot)",
    pillBg: "bg-[color-mix(in_oklch,var(--color-bear)_12%,transparent)]",
    pillText: "text-[var(--color-bear)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
  },
  HOLD: {
    tone: "neutral",
    icon: Minus,
    label: "Hold",
    pillBg: "bg-[var(--color-surface-hover)]",
    pillText: "text-[var(--color-fg-muted)]",
    ring: "ring-[var(--color-border-strong)]",
  },
};

const RISK_META: Record<RiskLevel, { label: string; tone: string }> = {
  low: { label: "Low risk", tone: "text-[var(--color-bull)]" },
  medium: { label: "Medium risk", tone: "text-[var(--color-warning)]" },
  high: { label: "High risk", tone: "text-[var(--color-bear)]" },
};

function ConfidenceRing({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const r = 18;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value);
  return (
    <div className="relative grid h-12 w-12 place-items-center">
      <svg width="48" height="48" viewBox="0 0 48 48" className="-rotate-90">
        <circle cx="24" cy="24" r={r} stroke="var(--color-border)" strokeWidth="3" fill="none" />
        <circle
          cx="24"
          cy="24"
          r={r}
          stroke="var(--color-brand)"
          strokeWidth="3"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="num absolute text-[11px] font-semibold">{pct}%</span>
    </div>
  );
}

export function SignalCard({ signal }: Props) {
  const meta = TRACKED_SYMBOLS.find((s) => s.id === signal.symbol)!;
  const pairLabel = getBrokerPair(signal.symbol, "futures");
  const t = TYPE_META[signal.type];
  const Icon = t.icon;
  const risk = RISK_META[signal.risk];

  return (
    // `@container` lets the Entry/Stop/Target grid below adapt to the card's
    // own width instead of the viewport — important on the Signals page where
    // the 360px sentiment sidebar squeezes each card to ~270px at xl, which is
    // too narrow to fit prices like `$81,905.78` in a 3-col field row.
    <Card className={cn("@container relative overflow-hidden ring-1 ring-inset", t.ring)}>
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
                {pairLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ring-1 ring-inset",
                t.pillBg,
                t.pillText,
                t.ring,
              )}
            >
              <Icon className="h-3 w-3" />
              {signal.type}
            </span>
            <ConfidenceRing value={signal.confidence} />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="mb-4 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">{t.label}</span>
            <span className={cn("text-[11px] font-medium", risk.tone)}>{risk.label}</span>
          </div>
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            RR {signal.riskReward.toFixed(2)} : 1
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2 text-xs @sm:grid-cols-3">
          <Field label="Entry" value={`$${formatPrice(signal.entry)}`} icon={<Sparkles className="h-3 w-3" />} />
          <Field
            label="Stop"
            value={`$${formatPrice(signal.stopLoss)}`}
            sub={`${formatPercent(((signal.stopLoss - signal.entry) / signal.entry) * 100)}`}
            tone={signal.type === "LONG" || signal.type === "BUY" ? "bear" : "bull"}
            icon={<ShieldAlert className="h-3 w-3" />}
          />
          <Field
            label="Target"
            value={`$${formatPrice(signal.target)}`}
            sub={`${formatPercent(((signal.target - signal.entry) / signal.entry) * 100)}`}
            tone={signal.type === "LONG" || signal.type === "BUY" ? "bull" : "bear"}
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
        ) : (
          <p className="mt-4 text-[11px] text-[var(--color-fg-subtle)]">
            All indicators are inconclusive. Stay flat.
          </p>
        )}
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
  // Compact horizontal layout when the card is narrow (container query),
  // vertical (label / value / sub stacked) when there's room. This keeps the
  // narrow-card variant from doubling the card's height while still letting
  // the wide-card variant breathe.
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
