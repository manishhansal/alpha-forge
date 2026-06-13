import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatCompact, formatPercent } from "@/lib/utils";
import type { FuturesSymbolView } from "@/types/market";

interface Props {
  symbols: FuturesSymbolView[];
}

export function OiCards({ symbols }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {symbols.map((s) => {
        const meta = TRACKED_SYMBOLS.find((m) => m.id === s.symbol)!;
        const positive = s.oiChangePct1h >= 0;
        return (
          <Card key={s.symbol}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{meta.name} OI</CardTitle>
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.16em]"
                  style={{ color: meta.color }}
                >
                  {s.symbol}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline justify-between">
                <span className="num text-2xl font-semibold tracking-tight">
                  ${formatCompact(s.openInterestNotionalUsd)}
                </span>
                <span
                  className={cn(
                    "num text-xs font-medium",
                    positive ? "text-bull" : "text-bear",
                  )}
                >
                  {formatPercent(s.oiChangePct1h)} 1h
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                    Contracts
                  </dt>
                  <dd className="num text-[12px] font-medium">{formatCompact(s.openInterest)}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                    Mark Price
                  </dt>
                  <dd className="num text-[12px] font-medium">${formatCompact(s.markPrice)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
