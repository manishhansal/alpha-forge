import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCompact, formatPrice } from "@/lib/utils";
import type { ExpiryStats } from "@/types/market";

interface Props {
  expiry: ExpiryStats;
  underlyingPrice: number;
}

export function StrikeOiTable({ expiry, underlyingPrice }: Props) {
  const sorted = [...expiry.topStrikes].sort((a, b) => a.strike - b.strike);
  const maxOi = Math.max(...sorted.map((s) => Math.max(s.callOi, s.putOi)), 1);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between">
          <CardTitle>OI by Strike · {expiry.expiryLabel}</CardTitle>
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            Spot ${formatPrice(underlyingPrice)} · Max pain ${formatPrice(expiry.maxPainStrike)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="min-w-full text-left">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
              <th className="px-4 py-2 text-right font-medium">Call OI</th>
              <th className="px-4 py-2 text-center font-medium">Strike</th>
              <th className="px-4 py-2 text-left font-medium">Put OI</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const isMaxPain = s.strike === expiry.maxPainStrike;
              const isAtm =
                underlyingPrice > 0 && Math.abs(s.strike - underlyingPrice) / underlyingPrice < 0.005;
              const callPct = (s.callOi / maxOi) * 100;
              const putPct = (s.putOi / maxOi) * 100;
              return (
                <tr
                  key={s.strike}
                  className={cn(
                    "border-b border-[var(--color-border)] last:border-b-0",
                    (isMaxPain || isAtm) && "bg-[var(--color-surface-hover)]/40",
                  )}
                >
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className="num text-xs font-medium">{formatCompact(s.callOi)}</span>
                      <div
                        className="h-1 rounded-full bg-[color-mix(in_oklch,var(--color-bull)_60%,transparent)]"
                        style={{ width: `${callPct}%`, maxWidth: 60 }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <div className="flex items-center justify-center gap-1.5 text-xs">
                      <span className="num font-medium">${formatPrice(s.strike)}</span>
                      {isMaxPain ? (
                        <span className="rounded bg-[color-mix(in_oklch,var(--color-warning)_18%,transparent)] px-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--color-warning)]">
                          MP
                        </span>
                      ) : null}
                      {isAtm ? (
                        <span className="rounded bg-[color-mix(in_oklch,var(--color-info)_18%,transparent)] px-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--color-info)]">
                          ATM
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-left">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-1 rounded-full bg-[color-mix(in_oklch,var(--color-bear)_60%,transparent)]"
                        style={{ width: `${putPct}%`, maxWidth: 60 }}
                      />
                      <span className="num text-xs font-medium">{formatCompact(s.putOi)}</span>
                    </div>
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
