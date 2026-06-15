"use client";

import * as React from "react";
import { ChevronDown, History } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmt, fmtPct } from "@/lib/india/format";
import { DAILY_PICK_BUCKET_META } from "@/features/india/daily-picks/engine";
import type {
  DailyPicksHistoryDay,
  DailyPicksHistoryResponse,
} from "@/features/india/daily-picks/builder";

/**
 * Past Daily Picks — every prior trading day's frozen picks with their final
 * outcome (target hit / stopped out / still open) and the day's win rate, so
 * the board is an auditable track record. Lazily fetched on mount.
 */
export function DailyPicksHistory({
  endpoint = "/api/in/daily-picks/history",
}: {
  endpoint?: string;
}) {
  const [days, setDays] = React.useState<DailyPicksHistoryDay[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(endpoint, { cache: "no-store", signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DailyPicksHistoryResponse;
        setDays(json.days);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      }
    })();
    return () => ac.abort();
  }, [endpoint]);

  if (error) {
    return (
      <p className="text-[12px] text-[var(--color-bear)]">
        Couldn&apos;t load history: {error}
      </p>
    );
  }
  if (days == null) {
    return (
      <p className="text-[12px] text-[var(--color-fg-subtle)]">Loading history…</p>
    );
  }
  if (days.length === 0) {
    return (
      <p className="text-[12px] text-[var(--color-fg-subtle)]">
        No past picks yet — history starts accruing from the first frozen
        trading day.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {days.map((day) => (
        <HistoryDay key={day.tradeDate} day={day} />
      ))}
    </div>
  );
}

function HistoryDay({ day }: { day: DailyPicksHistoryDay }) {
  const [open, setOpen] = React.useState(false);
  const allPicks = day.groups.flatMap((g) => g.picks);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--color-fg-subtle)]" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">
            {day.tradeDate}
          </span>
        </span>
        <span className="flex items-center gap-3 text-[11px] text-[var(--color-fg-muted)]">
          <span className="text-[var(--color-bull)]">{day.summary.targetHit} hit</span>
          <span className="text-[var(--color-bear)]">{day.summary.stopHit} stop</span>
          <span>{day.summary.open} open</span>
          <span className="num font-semibold text-[var(--color-fg)]">
            {(day.summary.winRate * 100).toFixed(0)}% win
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {open ? (
        <div className="overflow-x-auto border-t border-[var(--color-border)]">
          <table className="w-full text-left text-[11px]">
            <thead className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              <tr className="border-b border-[var(--color-border)]">
                <th className="px-4 py-2 font-medium">Bucket</th>
                <th className="px-3 py-2 font-medium">Symbol</th>
                <th className="px-3 py-2 font-medium">Dir</th>
                <th className="px-3 py-2 text-right font-medium">Entry</th>
                <th className="px-3 py-2 text-right font-medium">Stop</th>
                <th className="px-3 py-2 text-right font-medium">Target</th>
                <th className="px-3 py-2 text-right font-medium">P&amp;L</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {allPicks.map((p) => (
                <tr
                  key={`${p.bucket}-${p.rank}`}
                  className="border-b border-[var(--color-border)] last:border-0"
                >
                  <td className="px-4 py-2 text-[var(--color-fg-muted)]">
                    {DAILY_PICK_BUCKET_META[p.bucket].label.replace(
                      "Highly ",
                      "",
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium text-[var(--color-fg)]">
                    {p.displayName}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 font-medium",
                      p.direction === "BEARISH" ? "text-bear" : "text-bull",
                    )}
                  >
                    {p.direction === "BEARISH" ? "SHORT" : "LONG"}
                  </td>
                  <td className="num px-3 py-2 text-right">₹{fmt(p.entry)}</td>
                  <td className="num px-3 py-2 text-right">₹{fmt(p.stopLoss)}</td>
                  <td className="num px-3 py-2 text-right">₹{fmt(p.target)}</td>
                  <td
                    className={cn(
                      "num px-3 py-2 text-right font-medium",
                      p.pnlPct == null
                        ? "text-[var(--color-fg-muted)]"
                        : p.pnlPct >= 0
                          ? "text-bull"
                          : "text-bear",
                    )}
                  >
                    {p.pnlPct == null ? "—" : fmtPct(p.pnlPct)}
                  </td>
                  <td className="px-3 py-2">
                    <OutcomeTag status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function OutcomeTag({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    TARGET_HIT: { label: "Target", cls: "text-bull" },
    STOP_HIT: { label: "Stop", cls: "text-bear" },
    OPEN: { label: "Open", cls: "text-[var(--color-fg-muted)]" },
    EXPIRED: { label: "Expired", cls: "text-[var(--color-warning)]" },
  };
  const m = map[status] ?? map.OPEN;
  return <span className={cn("font-medium", m.cls)}>{m.label}</span>;
}
