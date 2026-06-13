import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCompact, formatPercent, formatPrice } from "@/lib/utils";
import type { TopMover } from "@/types/market";

interface Props {
  title: string;
  movers: TopMover[];
  tone: "bull" | "bear";
}

export function TopMoversCard({ title, movers, tone }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="min-w-full text-left">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <th className="px-4 py-2 font-medium">Symbol</th>
              <th className="px-4 py-2 text-right font-medium">Price</th>
              <th className="px-4 py-2 text-right font-medium">24h %</th>
              <th className="px-4 py-2 text-right font-medium">Volume</th>
            </tr>
          </thead>
          <tbody>
            {movers.map((m) => (
              <tr key={m.symbol} className="border-b border-[var(--color-border)] last:border-b-0">
                <td className="px-4 py-2.5 text-xs font-medium">{m.symbol.replace("USDT", "")}</td>
                <td className="num px-4 py-2.5 text-right text-xs">${formatPrice(m.price)}</td>
                <td
                  className={cn(
                    "num px-4 py-2.5 text-right text-xs font-medium",
                    tone === "bull" ? "text-bull" : "text-bear",
                  )}
                >
                  {formatPercent(m.changePct)}
                </td>
                <td className="num px-4 py-2.5 text-right text-xs text-[var(--color-fg-muted)]">
                  ${formatCompact(m.quoteVolume)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
