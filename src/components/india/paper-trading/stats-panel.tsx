import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getIndiaStrategyMeta } from "@/features/india/scalping/strategies/catalog";
import type {
  IndiaJournalStats,
  IndiaStrategyStats,
  IndiaSymbolStats,
} from "@/features/india/scalping/journal";

/**
 * India F&O performance panel. Mirror of the crypto `StatsPanel` — same
 * four headline tiles (Total / Win rate / Net P&L / Profit factor),
 * same per-symbol + per-strategy breakdown tables. Net P&L is shown in
 * ₹ instead of $.
 */

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

function pnlClass(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "text-[var(--color-fg-muted)]";
  return n > 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]";
}

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          F&amp;O Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Total"
            value={overall.total.toString()}
            hint={`${overall.open} open`}
          />
          <Stat
            label="Win rate"
            value={pct(overall.winRate)}
            hint={`${overall.wins}W / ${overall.losses}L`}
          />
          <Stat
            label="Net P&L"
            value={`₹${pnlText(overall.totalPnlUsd, 2)}`}
            valueClass={pnlClass(overall.totalPnlUsd)}
            hint={`per ${overall.total > 0 ? "₹1L" : "—"}`}
          />
          <Stat
            label="Profit factor"
            value={pfText(overall.profitFactor)}
            hint={`avg ${pnlText(overall.avgPnlPct, 2)}%`}
          />
        </div>

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
      </CardContent>
    </Card>
  );
}

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
      <Td align="right" className={pnlClass(stats.avgPnlPct)}>
        {pnlText(stats.avgPnlPct, 2)}%
      </Td>
      <Td align="right" className={pnlClass(stats.totalPnlUsd)}>
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
      <Td align="right" className={pnlClass(stats.avgPnlPct)}>
        {pnlText(stats.avgPnlPct, 2)}%
      </Td>
      <Td align="right" className={pnlClass(stats.totalPnlUsd)}>
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
      <p
        className={`mt-1 text-lg font-semibold tracking-tight num ${valueClass ?? ""}`}
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
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2 ${align === "right" ? "text-right num" : "text-left"} ${className ?? ""}`}
    >
      {children}
    </td>
  );
}
