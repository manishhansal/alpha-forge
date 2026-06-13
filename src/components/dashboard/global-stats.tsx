import { Card, CardContent } from "@/components/ui/card";
import { formatCompact } from "@/lib/utils";

interface GlobalStatsProps {
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  ethDominance: number;
  generatedAt: number;
}

interface StatProps {
  label: string;
  value: string;
  hint?: string;
}

function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="flex flex-1 flex-col gap-1 px-5 py-4">
      <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">{label}</span>
      <span className="num text-lg font-semibold text-[var(--color-fg)]">{value}</span>
      {hint ? <span className="text-[11px] text-[var(--color-fg-muted)]">{hint}</span> : null}
    </div>
  );
}

export function GlobalStats({
  totalMarketCap,
  totalVolume24h,
  btcDominance,
  ethDominance,
  generatedAt,
}: GlobalStatsProps) {
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="grid grid-cols-2 gap-px bg-[var(--color-border)] p-0 md:grid-cols-4">
        <div className="bg-[var(--color-surface)]">
          <Stat label="Total Market Cap" value={`$${formatCompact(totalMarketCap)}`} hint="All crypto assets" />
        </div>
        <div className="bg-[var(--color-surface)]">
          <Stat label="24h Spot Volume" value={`$${formatCompact(totalVolume24h)}`} hint="Global aggregate" />
        </div>
        <div className="bg-[var(--color-surface)]">
          <Stat label="BTC Dominance" value={`${btcDominance.toFixed(2)}%`} hint="Bitcoin share of cap" />
        </div>
        <div className="bg-[var(--color-surface)]">
          <Stat
            label="ETH Dominance"
            value={`${ethDominance.toFixed(2)}%`}
            hint={`Updated ${new Date(generatedAt).toLocaleTimeString()}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}
