"use client";

import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BentoGrid, BentoCell } from "@/components/layout/BentoGrid";
import { NumberMorph } from "@/components/trading/NumberMorph";
import { getIndiaStrategyMeta } from "@/features/india/scalping/strategies/catalog";
import type {
  IndiaJournalStats,
  IndiaStrategyStats,
  IndiaSymbolStats,
} from "@/features/india/scalping/journal";
import { PnlLineChart } from "@/components/india/paper-trading/pnl-line-chart";

/**
 * India F&O performance panel. Mirror of the crypto `StatsPanel` — same
 * four headline tiles (Total / Win rate / Net P&L / Profit factor),
 * same per-symbol + per-strategy breakdown tables. Net P&L is shown in
 * ₹ instead of $.
 *
 * Task 16.3: Refactored to use BentoGrid top stats sub-layout, NumberMorph
 * for total P&L, IIT color tokens, and dynamically imported RiskSphere.
 */

/* ── Dynamic RiskSphere import — keeps Three.js out of initial bundle ─────── */
const RiskSphere = dynamic(
  () => import("@/components/3d/risk-sphere").then((m) => ({ default: m.RiskSphere })),
  {
    ssr: false,
    loading: () => (
      <div className="h-[120px] w-[120px] animate-pulse rounded-full bg-[var(--color-surface)]" />
    ),
  },
);

/* ── Formatting helpers ──────────────────────────────────────────────────── */

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function pnlText(n: number, fractionDigits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(fractionDigits)}`;
}

function pfText(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  if (n === 0) return "—";
  return n.toFixed(2);
}

/** Returns an inline style object using IIT color tokens instead of ad-hoc Tailwind classes. */
function pnlStyle(n: number): React.CSSProperties {
  if (!Number.isFinite(n) || n === 0) return { color: "var(--color-fg-muted)" };
  return n > 0
    ? { color: "var(--color-data-positive)" }
    : { color: "var(--color-data-negative)" };
}

/* ── Main component ──────────────────────────────────────────────────────── */

export function IndiaStatsPanel({ stats }: { stats: IndiaJournalStats }) {
  const { overall, bySymbol, byStrategy } = stats;

  if (overall.total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            F&amp;O Performance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No F&amp;O paper trades have fired yet. The strategies page is
            already live and surfacing fresh F&amp;O signals — once the
            F&amp;O paper-trader worker ships, this panel will fill out
            automatically with per-symbol and per-strategy performance.
          </p>
        </CardContent>
      </Card>
    );
  }

  /* riskLevel: low win-rate = high risk */
  const riskLevel = (1 - overall.winRate) * 100;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          F&amp;O Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ── BentoGrid top stats sub-layout (4 cols) ── */}
        <BentoGrid cols={4} gap="gap-3">
          {/* Total P&L — spans 2 cols, large NumberMorph */}
          <BentoCell colSpan={2}>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 h-full">
              <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                Net P&L
              </p>
              <div className="mt-1" style={pnlStyle(overall.totalPnlUsd)}>
                <NumberMorph
                  value={overall.totalPnlUsd}
                  prefix="₹"
                  decimals={2}
                  className="text-2xl font-bold"
                />
              </div>
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                {`per ${overall.total > 0 ? "₹1L" : "—"}`}
              </p>
            </div>
          </BentoCell>

          {/* Win Rate — spans 1 col, with small arc gauge */}
          <BentoCell colSpan={1}>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 h-full flex flex-col items-center justify-center gap-1">
              <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)] self-start">
                Win Rate
              </p>
              <WinRateArc winRate={overall.winRate} />
              <p className="text-[10px] text-[var(--color-fg-subtle)]">
                {overall.wins}W / {overall.losses}L
              </p>
            </div>
          </BentoCell>

          {/* RiskSphere — spans 1 col */}
          <BentoCell colSpan={1}>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 h-full flex flex-col items-center justify-center gap-1">
              <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)] self-start">
                Risk
              </p>
              <RiskSphere riskLevel={riskLevel} size={80} />
            </div>
          </BentoCell>
        </BentoGrid>

        {/* ── Secondary stat row ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <Stat
            label="Total"
            value={overall.total.toString()}
            hint={`${overall.open} open`}
          />
          <Stat
            label="Profit factor"
            value={pfText(overall.profitFactor)}
            hint={`avg ${pnlText(overall.avgPnlPct, 2)}%`}
          />
        </div>

        {/* ── By symbol table ── */}
        <div className="min-w-0">
          <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            By symbol
          </p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full min-w-[420px] text-[12px]">
              <thead className="bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Symbol</Th>
                  <Th align="right">W/L</Th>
                  <Th align="right">Win rate</Th>
                  <Th align="right">Avg P&amp;L%</Th>
                  <Th align="right">Net ₹</Th>
                  <Th align="right">PF</Th>
                  <Th align="right">Open</Th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-3 text-[var(--color-fg-subtle)]">
                      No closed F&amp;O trades yet.
                    </td>
                  </tr>
                ) : (
                  bySymbol.map((s) => <SymbolRow key={s.symbol} stats={s} />)
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── By strategy table ── */}
        <div className="min-w-0">
          <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            By strategy
          </p>
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full min-w-[420px] text-[12px]">
              <thead className="bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Strategy</Th>
                  <Th align="right">W/L</Th>
                  <Th align="right">Win rate</Th>
                  <Th align="right">Avg P&amp;L%</Th>
                  <Th align="right">Net ₹</Th>
                  <Th align="right">Open</Th>
                </tr>
              </thead>
              <tbody>
                {byStrategy.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-3 text-[var(--color-fg-subtle)]">
                      No closed F&amp;O trades yet across the active strategies.
                    </td>
                  </tr>
                ) : (
                  byStrategy.map((s) => (
                    <StrategyRow key={s.strategyId} stats={s} />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Performance breakdown: cumulative P&L per strategy (lightweight-charts) ── */}
        <PnlLineChart height={200} autoFetch />
      </CardContent>
    </Card>
  );
}

/* ── Win Rate Arc gauge (small SVG) ─────────────────────────────────────── */

function WinRateArc({ winRate }: { winRate: number }) {
  const safeRate = Number.isFinite(winRate) ? winRate : 0;
  const pctLabel = `${(safeRate * 100).toFixed(1)}%`;

  /* SVG arc parameters */
  const radius = 28;
  const cx = 36;
  const cy = 36;
  const startAngle = -Math.PI * 0.75;
  const endAngle = Math.PI * 0.75;
  const totalArc = endAngle - startAngle;

  function polarToXY(angle: number, r: number) {
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  }

  const arcStart = polarToXY(startAngle, radius);
  const arcEnd = polarToXY(endAngle, radius);

  /* Full track */
  const trackPath = [
    `M ${arcStart.x} ${arcStart.y}`,
    `A ${radius} ${radius} 0 1 1 ${arcEnd.x} ${arcEnd.y}`,
  ].join(" ");

  /* Fill arc proportional to win rate */
  const fillAngle = startAngle + totalArc * safeRate;
  const fillEnd = polarToXY(fillAngle, radius);
  const largeArc = totalArc * safeRate > Math.PI ? 1 : 0;
  const fillPath = [
    `M ${arcStart.x} ${arcStart.y}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${fillEnd.x} ${fillEnd.y}`,
  ].join(" ");

  const fillColor =
    safeRate >= 0.6
      ? "var(--color-data-positive)"
      : safeRate >= 0.4
      ? "var(--color-fg-muted)"
      : "var(--color-data-negative)";

  return (
    <svg width={72} height={72} viewBox="0 0 72 72" aria-label={`Win rate ${pctLabel}`}>
      {/* Track */}
      <path
        d={trackPath}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      {/* Fill */}
      {safeRate > 0 && (
        <path
          d={fillPath}
          fill="none"
          stroke={fillColor}
          strokeWidth={5}
          strokeLinecap="round"
        />
      )}
      {/* Label */}
      <text
        x={cx}
        y={cy + 5}
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="var(--color-fg)"
        fontFamily="var(--font-data)"
      >
        {pctLabel}
      </text>
    </svg>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function StrategyRow({ stats }: { stats: IndiaStrategyStats }) {
  const meta = getIndiaStrategyMeta(stats.strategyId);
  return (
    <tr className="border-t border-[var(--color-border)]">
      <Td>
        <Badge variant={meta.badge} className="whitespace-nowrap px-1.5 py-0.5">
          <span className="whitespace-nowrap text-[10px] uppercase tracking-wider leading-none">
            {meta.label}
          </span>
        </Badge>
      </Td>
      <Td align="right">
        {stats.wins} / {stats.losses}
      </Td>
      <Td align="right">{pct(stats.winRate)}</Td>
      <Td align="right" style={pnlStyle(stats.avgPnlPct)}>
        {pnlText(stats.avgPnlPct, 2)}%
      </Td>
      <Td align="right" style={pnlStyle(stats.totalPnlUsd)}>
        {pnlText(stats.totalPnlUsd, 2)}
      </Td>
      <Td align="right">{stats.open}</Td>
    </tr>
  );
}

function SymbolRow({ stats }: { stats: IndiaSymbolStats }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <Td>
        <span className="font-semibold">{stats.symbol}</span>
      </Td>
      <Td align="right">
        {stats.wins} / {stats.losses}
      </Td>
      <Td align="right">{pct(stats.winRate)}</Td>
      <Td align="right" style={pnlStyle(stats.avgPnlPct)}>
        {pnlText(stats.avgPnlPct, 2)}%
      </Td>
      <Td align="right" style={pnlStyle(stats.totalPnlUsd)}>
        {pnlText(stats.totalPnlUsd, 2)}
      </Td>
      <Td align="right">{pfText(stats.profitFactor)}</Td>
      <Td align="right">{stats.open}</Td>
    </tr>
  );
}

function Stat({
  label,
  value,
  hint,
  valueStyle,
}: {
  label: string;
  value: string;
  hint?: string;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p
        className="mt-1 text-lg font-semibold tracking-tight num"
        style={valueStyle}
      >
        {value}
      </p>
      {hint ? (
        <p className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</p>
      ) : null}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
  style,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td
      className={`px-3 py-2 ${align === "right" ? "text-right num" : "text-left"} ${className ?? ""}`}
      style={style}
    >
      {children}
    </td>
  );
}
