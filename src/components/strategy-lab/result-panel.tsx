"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EquitySparkline } from "@/components/strategy-lab/equity-sparkline";
import { cn, formatPrice } from "@/lib/utils";
import type {
  BacktestResult,
  ParsedStrategy,
} from "@/features/strategy-lab/types";

interface Props {
  /** The full backtest payload returned by the engine. */
  result: BacktestResult;
  /** Optional: render the sparkline narrower for sidebar layouts. */
  height?: number;
}

export function ResultPanel({ result, height = 140 }: Props) {
  const { stats, trades, equityCurve, parsed } = result;

  return (
    <div className="flex flex-col gap-4">
      <SummaryCard parsed={parsed} />

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Performance
          </CardTitle>
          <Badge variant={stats.totalReturnPct >= 0 ? "bull" : "bear"}>
            {stats.totalReturnPct >= 0 ? "+" : ""}
            {stats.totalReturnPct.toFixed(2)}%
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Total trades"
              value={stats.totalTrades.toString()}
              hint={`${stats.wins}W / ${stats.losses}L`}
            />
            <Stat
              label="Win rate"
              value={pct(stats.winRate)}
              hint={`avg win ${signedPct(stats.avgWinPct)} · loss ${signedPct(stats.avgLossPct)}`}
              valueClass={stats.winRate >= 0.5 ? "text-[var(--color-bull)]" : undefined}
            />
            <Stat
              label="Max drawdown"
              value={pct(stats.maxDrawdownPct)}
              hint="peak-to-trough"
              valueClass="text-[var(--color-bear)]"
            />
            <Stat
              label="Sharpe (ann.)"
              value={stats.sharpe.toFixed(2)}
              hint={`bar interval ${stats.interval}`}
              valueClass={
                stats.sharpe >= 1
                  ? "text-[var(--color-bull)]"
                  : stats.sharpe < 0
                    ? "text-[var(--color-bear)]"
                    : undefined
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Net P&L"
              value={`${stats.totalPnlUsd >= 0 ? "+" : ""}$${stats.totalPnlUsd.toFixed(2)}`}
              hint={`from $${stats.startEquity.toFixed(0)} notional`}
              valueClass={pnlClass(stats.totalPnlUsd)}
            />
            <Stat
              label="Profit factor"
              value={pfText(stats.profitFactor)}
              hint={`largest win ${signedPct(stats.largestWinPct)}`}
            />
            <Stat
              label="Buy & hold"
              value={`${stats.buyHoldReturnPct >= 0 ? "+" : ""}${stats.buyHoldReturnPct.toFixed(2)}%`}
              hint={`vs ${stats.totalReturnPct.toFixed(2)}% strategy`}
              valueClass={
                stats.totalReturnPct > stats.buyHoldReturnPct
                  ? "text-[var(--color-bull)]"
                  : "text-[var(--color-bear)]"
              }
            />
            <Stat
              label="Avg hold"
              value={`${Math.round(stats.avgBarsHeld)} bars`}
              hint={`largest loss ${signedPct(stats.largestLossPct)}`}
            />
          </div>

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              Equity curve
            </p>
            <EquitySparkline curve={equityCurve} height={height} />
            <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--color-fg-subtle)]">
              <span>${stats.startEquity.toFixed(0)}</span>
              <span>${stats.endEquity.toFixed(2)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <TradeTable trades={trades} />
    </div>
  );
}

function SummaryCard({ parsed }: { parsed: ParsedStrategy }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          How we read your strategy
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={parsed.side === "LONG" ? "bull" : "bear"}>{parsed.side}</Badge>
          {parsed.entry.conditions.length === 0 ? (
            <Badge variant="warning">No entry rule detected</Badge>
          ) : null}
          {parsed.exit ? <Badge variant="info">Custom exit</Badge> : null}
          {parsed.risk.stopLossPct ? (
            <Badge variant="outline">SL {(parsed.risk.stopLossPct * 100).toFixed(2)}%</Badge>
          ) : null}
          {parsed.risk.takeProfitPct ? (
            <Badge variant="outline">TP {(parsed.risk.takeProfitPct * 100).toFixed(2)}%</Badge>
          ) : null}
          {parsed.risk.maxHoldBars ? (
            <Badge variant="outline">max hold {parsed.risk.maxHoldBars}</Badge>
          ) : null}
        </div>
        {parsed.summary.length > 0 ? (
          <ul className="list-disc pl-5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {parsed.summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
        {parsed.warnings.length > 0 ? (
          <div className="rounded-lg border border-[var(--color-warning)]/40 bg-[color-mix(in_oklch,var(--color-warning)_8%,transparent)] p-3 text-[11px] text-[var(--color-warning)]">
            <p className="mb-1 font-semibold uppercase tracking-[0.12em]">Couldn&apos;t fully parse</p>
            <ul className="list-disc pl-4">
              {parsed.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TradeTable({ trades }: { trades: BacktestResult["trades"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Trade log
        </CardTitle>
      </CardHeader>
      <CardContent>
        {trades.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No trades fired during this period. Try loosening your conditions or extending the
            window.
          </p>
        ) : (
          <div className="max-h-[360px] overflow-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Side</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Exit</Th>
                  <Th align="right">P&amp;L %</Th>
                  <Th align="right">P&amp;L $</Th>
                  <Th align="right">Bars</Th>
                  <Th align="right">Reason</Th>
                  <Th align="right">Closed</Th>
                </tr>
              </thead>
              <tbody>
                {trades.slice(-200).reverse().map((t, i) => (
                  <tr key={`${t.openedAt}-${i}`} className="border-t border-[var(--color-border)]">
                    <Td>
                      <Badge variant={t.side === "LONG" ? "bull" : "bear"}>{t.side}</Badge>
                    </Td>
                    <Td align="right">${formatPrice(t.entry)}</Td>
                    <Td align="right">${formatPrice(t.exit)}</Td>
                    <Td align="right" className={pnlClass(t.pnlPct)}>
                      {signedPct(t.pnlPct)}
                    </Td>
                    <Td align="right" className={pnlClass(t.pnlUsd)}>
                      {t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)}
                    </Td>
                    <Td align="right">{t.bars}</Td>
                    <Td align="right" className="text-[var(--color-fg-subtle)]">
                      {t.reason}
                    </Td>
                    <Td align="right" className="text-[var(--color-fg-subtle)]">
                      {new Date(t.closedAt).toLocaleString()}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}
function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function pfText(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  if (n === 0) return "—";
  return n.toFixed(2);
}
function pnlClass(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "text-[var(--color-fg-muted)]";
  return n > 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]";
}

function Stat({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className={cn("mt-1 text-lg font-semibold tracking-tight num", valueClass)}>{value}</p>
      {hint ? <p className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</p> : null}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em]",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2",
        align === "right" ? "text-right num" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
