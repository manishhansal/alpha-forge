import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCompact, formatPrice } from "@/lib/utils";
import type { ExpiryStats } from "@/types/market";

interface Props {
  expiries: ExpiryStats[];
  underlyingPrice: number;
}

export function ExpiryTable({ expiries, underlyingPrice }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Expiries</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="min-w-full text-left">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <th className="px-4 py-2 font-medium">Expiry</th>
              <th className="px-4 py-2 text-right font-medium">DTE</th>
              <th className="px-4 py-2 text-right font-medium">Max Pain</th>
              <th className="px-4 py-2 text-right font-medium">ATM IV</th>
              <th className="px-4 py-2 text-right font-medium">Call OI</th>
              <th className="px-4 py-2 text-right font-medium">Put OI</th>
              <th className="px-4 py-2 text-right font-medium">PCR · OI</th>
            </tr>
          </thead>
          <tbody>
            {expiries.map((e) => {
              const distancePct =
                underlyingPrice > 0 ? ((e.maxPainStrike - underlyingPrice) / underlyingPrice) * 100 : 0;
              const pcrCls =
                e.pcrOi > 1.1 ? "text-bear" : e.pcrOi < 0.7 ? "text-bull" : "text-[var(--color-fg-muted)]";
              return (
                <tr key={e.expiryTs} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="px-4 py-2.5 text-xs font-medium">{e.expiryLabel}</td>
                  <td className="num px-4 py-2.5 text-right text-xs text-[var(--color-fg-muted)]">
                    {Math.round(e.daysToExpiry)}d
                  </td>
                  <td className="num px-4 py-2.5 text-right text-xs">
                    <div className="flex flex-col items-end leading-tight">
                      <span className="font-medium">${formatPrice(e.maxPainStrike)}</span>
                      <span
                        className={cn(
                          "text-[10px]",
                          distancePct >= 0 ? "text-bull" : "text-bear",
                        )}
                      >
                        {distancePct >= 0 ? "+" : ""}
                        {distancePct.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                  <td className="num px-4 py-2.5 text-right text-xs text-[var(--color-fg-muted)]">
                    {(e.atmIv).toFixed(1)}%
                  </td>
                  <td className="num px-4 py-2.5 text-right text-xs">{formatCompact(e.callOi)}</td>
                  <td className="num px-4 py-2.5 text-right text-xs">{formatCompact(e.putOi)}</td>
                  <td className={cn("num px-4 py-2.5 text-right text-xs font-medium", pcrCls)}>
                    {e.pcrOi.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
