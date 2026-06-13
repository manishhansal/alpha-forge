import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import type { FuturesSymbolView } from "@/types/market";

interface Props {
  symbols: FuturesSymbolView[];
}

function ToothbarRow({ row }: { row: FuturesSymbolView }) {
  const meta = TRACKED_SYMBOLS.find((m) => m.id === row.symbol)!;
  const longPct = row.longAccount > 0 ? row.longAccount * 100 : 50;
  const shortPct = row.shortAccount > 0 ? row.shortAccount * 100 : 50;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span
            className="grid h-5 w-5 place-items-center rounded-full text-[10px] font-semibold"
            style={{
              background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
              color: meta.color,
            }}
          >
            {row.symbol}
          </span>
          <span className="text-[var(--color-fg-muted)]">L/S {row.longShortRatio.toFixed(2)}</span>
        </div>
        <div className="flex gap-3 text-[11px]">
          <span className="text-bull">{longPct.toFixed(0)}% long</span>
          <span className="text-bear">{shortPct.toFixed(0)}% short</span>
        </div>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        <div
          className="h-full bg-[var(--color-bull)]"
          style={{ width: `${longPct}%` }}
        />
        <div
          className="h-full bg-[var(--color-bear)]"
          style={{ width: `${shortPct}%` }}
        />
      </div>
    </div>
  );
}

export function LongShortGauge({ symbols }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Long / Short Account Ratio</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {symbols.map((s) => (
            <ToothbarRow key={s.symbol} row={s} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
