"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  computeIndiaLivePnl,
  useIndiaJournalData,
} from "@/components/india/paper-trading/journal-data-context";
import {
  FilterInput,
  FilterSelect,
  IndiaStrategyChip,
  Td,
  Th,
  indiaPnlClass,
  indiaStatusBadge,
} from "@/components/india/paper-trading/journal-shared";
import { useIndiaStrategyFilter } from "@/components/india/strategies/strategy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fmt } from "@/lib/india/format";
import { cn } from "@/lib/utils";
import type { IndiaPaperTradeStatus } from "@/features/india/scalping/types";

const STATUSES: ReadonlyArray<"ALL" | IndiaPaperTradeStatus> = [
  "ALL",
  "OPEN",
  "WIN",
  "LOSS",
  "EXPIRED",
  "CANCELLED",
];

/**
 * Server-paginated India F&O journal. Mirror of the crypto
 * `JournalCard` — same column set (₹ swapped for $), same status /
 * symbol filters, same in-place note editor and pagination strip.
 *
 * `symbol` is a free-form text filter (instead of the crypto's
 * BTC/ETH/SOL <select>) because the NSE F&O universe is large and
 * open-ended.
 */
export function IndiaJournalCard() {
  const {
    items,
    prices,
    loading,
    symbol,
    status,
    setSymbol,
    setStatus,
    page,
    pageSize,
    total,
    totalPages,
    setPage,
    saveNote,
  } = useIndiaJournalData();
  const { selected, pairs } = useIndiaStrategyFilter();

  const [editing, setEditing] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string>("");

  const onSaveNote = useCallback(
    async (id: string) => {
      const trimmed = editingNote.trim();
      await saveNote(id, trimmed === "" ? null : trimmed);
      setEditing(null);
      setEditingNote("");
    },
    [editingNote, saveNote],
  );

  const pageStart = (page - 1) * pageSize;
  const pageEnd = Math.min(pageStart + items.length, total);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Journal · F&amp;O trade history
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            {loading
              ? "Refreshing…"
              : `${total} trade${total === 1 ? "" : "s"} matching · ${pairs.length} lanes (${selected.size} strategies)`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterInput
            label="Symbol"
            value={symbol === "ALL" ? "" : symbol}
            onChange={(v) => setSymbol(v.trim() === "" ? "ALL" : v.trim().toUpperCase())}
            placeholder="NIFTY"
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as "ALL" | IndiaPaperTradeStatus)}
            options={[...STATUSES]}
          />
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 && total === 0 && !loading ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No F&amp;O paper trades match the current filters yet. Once the
            F&amp;O paper-trader worker books its first trade, rows will
            appear here automatically.
          </p>
        ) : items.length === 0 && loading ? (
          <Skeleton className="h-[120px] w-full rounded-lg" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Symbol</Th>
                  <Th>Strategy</Th>
                  <Th>Side</Th>
                  <Th>Status</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Exit</Th>
                  <Th align="right">P&amp;L %</Th>
                  <Th align="right">P&amp;L ₹</Th>
                  <Th align="right">Opened</Th>
                  <Th align="right">Closed</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => {
                  const isOpen = t.status === "OPEN";
                  const live = isOpen ? computeIndiaLivePnl(t, prices[t.symbol]) : null;
                  const pnlPct = isOpen ? live?.pct ?? null : t.pnlPct;
                  const pnlUsd = isOpen ? live?.usd ?? null : t.pnlUsd;
                  const exitDisplay = isOpen
                    ? prices[t.symbol] !== undefined
                      ? `₹${fmt(prices[t.symbol], 2)}`
                      : "—"
                    : t.exitPrice !== null
                      ? `₹${fmt(t.exitPrice, 2)}`
                      : "—";
                  return (
                    <tr
                      key={t.id}
                      className={cn(
                        "border-t border-[var(--color-border)]",
                        isOpen
                          ? "bg-[color-mix(in_oklch,var(--color-info)_5%,transparent)]"
                          : "",
                      )}
                    >
                      <Td>
                        <span className="font-semibold">{t.symbol}</span>
                      </Td>
                      <Td>
                        <IndiaStrategyChip
                          strategyId={t.strategyId}
                          timeframe={t.strategyTimeframe}
                        />
                      </Td>
                      <Td>
                        <Badge variant={t.direction === "LONG" ? "bull" : "bear"}>
                          {t.direction}
                        </Badge>
                      </Td>
                      <Td>{indiaStatusBadge(t.status)}</Td>
                      <Td align="right">₹{fmt(t.entry, 2)}</Td>
                      <Td align="right">
                        {isOpen && prices[t.symbol] !== undefined ? (
                          <span className="relative inline-block leading-none">
                            <span className="pointer-events-none absolute -top-2 right-0 text-[8px] font-semibold uppercase tracking-wider leading-none text-[var(--color-bear)]">
                              live
                            </span>
                            {exitDisplay}
                          </span>
                        ) : (
                          exitDisplay
                        )}
                      </Td>
                      <Td align="right" className={indiaPnlClass(pnlPct)}>
                        {pnlPct !== null
                          ? `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
                          : "—"}
                      </Td>
                      <Td align="right" className={indiaPnlClass(pnlUsd)}>
                        {pnlUsd !== null
                          ? `${pnlUsd > 0 ? "+" : ""}₹${pnlUsd.toFixed(2)}`
                          : "—"}
                      </Td>
                      <Td align="right" className="text-[var(--color-fg-subtle)]">
                        {new Date(t.openedAt).toLocaleString()}
                      </Td>
                      <Td align="right" className="text-[var(--color-fg-subtle)]">
                        {t.closedAt ? new Date(t.closedAt).toLocaleString() : "—"}
                      </Td>
                      <Td>
                        {editing === t.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={editingNote}
                              onChange={(e) => setEditingNote(e.target.value)}
                              placeholder="Add note…"
                              className="h-7 text-[11px]"
                            />
                            <Button size="sm" onClick={() => void onSaveNote(t.id)}>
                              Save
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                              ×
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="text-left text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                            onClick={() => {
                              setEditing(t.id);
                              setEditingNote(t.note ?? "");
                            }}
                          >
                            {t.note ?? (
                              <span className="text-[var(--color-fg-subtle)]">
                                add…
                              </span>
                            )}
                          </button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 ? (
          <PaginationFooter
            page={page}
            totalPages={totalPages}
            pageStart={pageStart}
            pageEnd={pageEnd}
            total={total}
            disabled={loading}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
            onJump={(p) => setPage(p)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PaginationFooter({
  page,
  totalPages,
  pageStart,
  pageEnd,
  total,
  disabled,
  onPrev,
  onNext,
  onJump,
}: {
  page: number;
  totalPages: number;
  pageStart: number;
  pageEnd: number;
  total: number;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (p: number) => void;
}) {
  const pages = useMemo(() => buildPageList(page, totalPages), [page, totalPages]);
  const prevDisabled = disabled || page <= 1;
  const nextDisabled = disabled || page >= totalPages;

  return (
    <div className="mt-3 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        Showing{" "}
        <span className="num text-[var(--color-fg-muted)]">
          {total === 0 ? 0 : pageStart + 1}–{pageEnd}
        </span>{" "}
        of <span className="num text-[var(--color-fg-muted)]">{total}</span>
      </p>
      <nav
        aria-label="Journal pagination"
        className="flex items-center gap-1"
      >
        <button
          type="button"
          onClick={onPrev}
          disabled={prevDisabled}
          aria-label="Previous page"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors",
            prevDisabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
          )}
        >
          <ChevronLeft className="h-3 w-3" />
          Prev
        </button>
        <div className="flex items-center gap-1">
          {pages.map((p, i) =>
            p === "…" ? (
              <span
                key={`ellipsis-${i}`}
                className="px-1.5 text-[11px] text-[var(--color-fg-subtle)]"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onJump(p)}
                disabled={disabled && p !== page}
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
                className={cn(
                  "h-7 min-w-7 rounded-md px-2 text-[11px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  p === page
                    ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-info)_40%,transparent)]"
                    : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
                )}
              >
                {p}
              </button>
            ),
          )}
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          aria-label="Next page"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors",
            nextDisabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
          )}
        >
          Next
          <ChevronRight className="h-3 w-3" />
        </button>
      </nav>
    </div>
  );
}

function buildPageList(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, total, current, current - 1, current + 1]);
  const pages = [...set]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);

  const out: Array<number | "…"> = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) out.push("…");
    out.push(pages[i]);
  }
  return out;
}
