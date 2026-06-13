import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SECTOR_LABEL } from "@/features/heatmap/sectors";
import type { SectorRow } from "@/features/heatmap/aggregate";
import { cn, formatCompact, formatPercent } from "@/lib/utils";

interface SectorStripProps {
  rows: SectorRow[];
}

function tone(pct: number): { bar: string; text: string } {
  if (pct >= 0) {
    return {
      bar: "bg-[color-mix(in_oklch,var(--color-bull)_55%,transparent)]",
      text: "text-[var(--color-bull)]",
    };
  }
  return {
    bar: "bg-[color-mix(in_oklch,var(--color-bear)_55%,transparent)]",
    text: "text-[var(--color-bear)]",
  };
}

export function SectorStrip({ rows }: SectorStripProps) {
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.changePct)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sector performance · 24h</CardTitle>
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          Volume-weighted mean across each sector&apos;s tracked perpetuals.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-[var(--color-fg-muted)]">
            Sector data unavailable.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const pct = r.changePct;
              const t = tone(pct);
              const widthPct = (Math.abs(pct) / maxAbs) * 50;
              return (
                <li
                  key={r.sector}
                  className="grid grid-cols-[120px_1fr_auto] items-center gap-3 text-[12px]"
                >
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium text-[var(--color-fg)]">{SECTOR_LABEL[r.sector]}</span>
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                      {r.count} pairs · ${formatCompact(r.quoteVolume)}
                    </span>
                  </div>

                  {/* Symmetric bar — center at 50%, grow left for negatives, right for positives. */}
                  <div className="relative h-2 w-full rounded-full bg-[var(--color-surface-hover)]">
                    <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-border)]" />
                    <span
                      className={cn(
                        "absolute inset-y-0 rounded-full",
                        t.bar,
                        pct >= 0 ? "left-1/2" : "right-1/2",
                      )}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>

                  <div className="flex items-baseline gap-2">
                    <span className={cn("num font-semibold tabular-nums", t.text)}>
                      {formatPercent(pct)}
                    </span>
                    <span className="num text-[10px] text-[var(--color-fg-subtle)]">
                      {formatPercent(r.worst)} … {formatPercent(r.best)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
