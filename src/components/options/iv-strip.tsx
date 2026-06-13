import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExpiryStats } from "@/types/market";

interface Props {
  expiries: ExpiryStats[];
}

export function IvStrip({ expiries }: Props) {
  const max = Math.max(...expiries.map((e) => e.atmIv), 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle>ATM Implied Volatility · Term Structure</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {expiries.map((e) => {
            const heightPct = (e.atmIv / max) * 100;
            return (
              <div key={e.expiryTs} className="flex flex-col items-center gap-2">
                <div className="relative flex h-24 w-full items-end justify-center">
                  <div
                    className="w-full rounded-md bg-gradient-to-t from-[var(--color-info)] to-[color-mix(in_oklch,var(--color-info)_60%,transparent)]"
                    style={{ height: `${Math.max(8, heightPct)}%` }}
                    title={`${e.atmIv.toFixed(1)}% IV`}
                  />
                </div>
                <div className="flex flex-col items-center leading-tight">
                  <span className="num text-xs font-medium">{e.atmIv.toFixed(1)}%</span>
                  <span className="text-[10px] text-[var(--color-fg-muted)]">{e.expiryLabel}</span>
                  <span className="text-[10px] text-[var(--color-fg-subtle)]">
                    {Math.round(e.daysToExpiry)}d
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
