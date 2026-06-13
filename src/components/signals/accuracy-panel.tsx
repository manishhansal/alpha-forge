import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AccuracySummary } from "@/features/backtesting/history";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pnlText(n: number | null): string {
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function pnlClass(n: number | null): string {
  if (n === null || n === 0) return "text-[var(--color-fg-muted)]";
  return n > 0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]";
}

function outcomeBadge(outcome: string): React.ReactNode {
  if (outcome === "HIT_TARGET") return <Badge variant="bull">Target</Badge>;
  if (outcome === "HIT_STOP") return <Badge variant="bear">Stop</Badge>;
  if (outcome === "EXPIRED") return <Badge variant="outline">Expired</Badge>;
  return <Badge variant="neutral">{outcome}</Badge>;
}

export function AccuracyPanel({ summary }: { summary: AccuracySummary }) {
  const { overall, bySymbol, recentClosed } = summary;
  const closed = overall.hitTarget + overall.hitStop + overall.expired;

  if (overall.total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Historical accuracy</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No signals recorded yet. Start the worker (<code className="font-mono">npm run worker:dev</code>)
            and signals will begin accumulating here as the engine generates them and the outcome
            tracker resolves them.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Historical accuracy</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={overall.total.toString()} />
          <Stat label="Win rate" value={closed > 0 ? pct(overall.winRate) : "—"} hint={`${closed} closed`} />
          <Stat
            label="Avg P&L"
            value={pnlText(overall.avgPnlPct)}
            valueClass={pnlClass(overall.avgPnlPct)}
            hint="all closed"
          />
          <Stat label="Open" value={overall.open.toString()} />
        </div>

        <div>
          <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            By symbol
          </p>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Symbol</Th>
                  <Th align="right">Closed</Th>
                  <Th align="right">Win rate</Th>
                  <Th align="right">Avg P&L</Th>
                  <Th align="right">Open</Th>
                </tr>
              </thead>
              <tbody>
                {bySymbol.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-3 text-[var(--color-fg-subtle)]">
                      No closed signals yet.
                    </td>
                  </tr>
                ) : (
                  bySymbol.map((s) => {
                    const sClosed = s.hitTarget + s.hitStop + s.expired;
                    return (
                      <tr key={s.symbol} className="border-t border-[var(--color-border)]">
                        <Td>
                          <span className="font-semibold">{s.symbol}</span>
                        </Td>
                        <Td align="right">{sClosed}</Td>
                        <Td align="right">{sClosed > 0 ? pct(s.winRate) : "—"}</Td>
                        <Td align="right" className={pnlClass(s.avgPnlPct)}>
                          {pnlText(s.avgPnlPct)}
                        </Td>
                        <Td align="right">{s.open}</Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {recentClosed.length > 0 ? (
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
              Recently closed
            </p>
            <ul className="flex flex-col gap-1.5">
              {recentClosed.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{row.symbol}</span>
                    <Badge variant="outline">{row.type}</Badge>
                    {outcomeBadge(row.outcome)}
                  </div>
                  <div className="flex items-center gap-3 text-[var(--color-fg-muted)]">
                    <span className={`num ${pnlClass(row.pnlPct)}`}>{pnlText(row.pnlPct)}</span>
                    <span className="text-[11px] text-[var(--color-fg-subtle)]">
                      {row.closedAt ? new Date(row.closedAt).toLocaleString() : "—"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
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
      <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">{label}</p>
      <p className={`mt-1 text-lg font-semibold tracking-tight num ${valueClass ?? ""}`}>{value}</p>
      {hint ? <p className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</p> : null}
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
