import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCompact } from "@/lib/utils";

interface Props {
  pcrOi: number;
  pcrVolume: number;
  totalCallOi: number;
  totalPutOi: number;
  totalCallVolume: number;
  totalPutVolume: number;
}

function pcrTone(pcr: number): { label: string; tone: "bull" | "bear" | "neutral" } {
  if (pcr > 1.1) return { label: "Bearish bias", tone: "bear" };
  if (pcr < 0.7) return { label: "Bullish bias", tone: "bull" };
  return { label: "Balanced", tone: "neutral" };
}

const TONE_TEXT: Record<string, string> = {
  bull: "text-bull",
  bear: "text-bear",
  neutral: "text-[var(--color-fg-muted)]",
};

export function PcrCard({ pcrOi, pcrVolume, totalCallOi, totalPutOi, totalCallVolume, totalPutVolume }: Props) {
  const oiTone = pcrTone(pcrOi);
  const volTone = pcrTone(pcrVolume);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Put / Call Ratio</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">PCR · OI</span>
            <span className="num text-2xl font-semibold tracking-tight">{pcrOi.toFixed(2)}</span>
            <span className={cn("text-[11px] font-medium", TONE_TEXT[oiTone.tone])}>{oiTone.label}</span>
            <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-[var(--color-fg-muted)]">
              <span>Calls {formatCompact(totalCallOi)}</span>
              <span>Puts {formatCompact(totalPutOi)}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 border-l border-[var(--color-border)] pl-4">
            <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">PCR · Volume</span>
            <span className="num text-2xl font-semibold tracking-tight">{pcrVolume.toFixed(2)}</span>
            <span className={cn("text-[11px] font-medium", TONE_TEXT[volTone.tone])}>{volTone.label}</span>
            <div className="mt-2 grid grid-cols-2 gap-1 text-[11px] text-[var(--color-fg-muted)]">
              <span>Calls {formatCompact(totalCallVolume)}</span>
              <span>Puts {formatCompact(totalPutVolume)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
