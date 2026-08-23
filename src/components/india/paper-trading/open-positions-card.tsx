"use client";

import React, { useCallback, useMemo, useState } from "react";

import {
  computeIndiaLivePnl,
  useIndiaJournalData,
  type ApiIndiaPaperTrade,
} from "@/components/india/paper-trading/journal-data-context";
import {
  IndiaStrategyChip,
  Td,
  Th,
} from "@/components/india/paper-trading/journal-shared";
import { useIndiaStrategyFilter } from "@/components/india/strategies/strategy-context";
import {
  FilterTabs,
  PaginationStrip,
  usePaginationFilter,
} from "@/components/india/ui/pagination-filter";
import { NumberMorph } from "@/components/trading/NumberMorph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt } from "@/lib/india/format";
import { cn, fmtDateTime } from "@/lib/utils";

/**
 * Live MTM table for India F&O paper trades. Visual mirror of the
 * crypto `OpenPositionsCard` — same column set, same defensive client-
 * side strategy filter so deselecting a strategy hides its OPEN trades
 * even if the server response hasn't refreshed yet.
 */
export function IndiaOpenPositionsCard() {
  const { open, prices, cancelTrade, refresh } = useIndiaJournalData();
  const { selected, timeframesFor } = useIndiaStrategyFilter();
  const [closingAll, setClosingAll] = useState(false);
  const [closeAllState, setCloseAllState] = React.useState<"idle" | "confirming">("idle");
  const confirmTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCloseAll = useCallback(async () => {
    if (closeAllState === "idle") {
      // First click — enter confirming state
      setCloseAllState("confirming");
      confirmTimeoutRef.current = setTimeout(() => {
        setCloseAllState("idle");
      }, 3000);
      return;
    }

    // Second click within 3s — execute
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setCloseAllState("idle");

    if (closingAll) return;
    setClosingAll(true);
    try {
      await fetch("/api/in/scalper/close-all", { method: "POST" });
      await refresh();
    } finally {
      setClosingAll(false);
    }
  }, [closeAllState, closingAll, refresh]);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  const isRowSelected = useCallback(
    (t: ApiIndiaPaperTrade) =>
      selected.has(t.strategyId) &&
      timeframesFor(t.strategyId).has(t.strategyTimeframe),
    [selected, timeframesFor],
  );
  const visibleOpen = useMemo(
    () => open.filter(isRowSelected),
    [open, isRowSelected],
  );

  const getConfidence = useCallback(
    (t: ApiIndiaPaperTrade) => {
      // RiskReward as confidence proxy — higher RR = more confident setup
      return Math.min(t.riskReward / 3, 1);
    },
    [],
  );

  const getWinrate = useCallback(
    (t: ApiIndiaPaperTrade) => {
      // Unrealized P&L % as winrate proxy — positive means winning
      const mark = prices[t.symbol];
      const live = computeIndiaLivePnl(t, mark);
      if (!live) return 0.5;
      // Normalize: +5% → 1.0, −5% → 0.0
      return Math.min(Math.max((live.pct + 5) / 10, 0), 1);
    },
    [prices],
  );

  const {
    pageItems,
    activeTab,
    setActiveTab,
    page,
    setPage,
    totalPages,
    filteredTotal,
    pageSize,
    tabs,
  } = usePaginationFilter({
    items: visibleOpen,
    pageSize: 5,
    getConfidence,
    getWinrate,
    confidenceThreshold: 0.7,
    winrateThreshold: 0.6,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Open F&amp;O paper positions
        </CardTitle>
        <div className="flex items-center gap-2">
          {visibleOpen.length > 0 && (
            <FilterTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          )}
          {open.length > 0 && (
            <button
              type="button"
              onClick={handleCloseAll}
              disabled={closingAll}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-all",
                closeAllState === "confirming"
                  ? "border-rose-500/60 bg-rose-500/20 text-rose-600 animate-pulse dark:text-rose-400"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 dark:text-rose-400",
                closingAll && "disabled:opacity-60"
              )}
              title={
                closeAllState === "confirming"
                  ? "Click again to confirm closing all positions"
                  : "Close all open India paper trades at current market price"
              }
              aria-label={
                closeAllState === "confirming"
                  ? "Confirm close all positions"
                  : "Close all positions"
              }
            >
              {closingAll
                ? "Closing…"
                : closeAllState === "confirming"
                ? `Confirm? (${open.length})`
                : `Close All (${open.length})`}
            </button>
          )}
          <Badge variant={visibleOpen.length > 0 ? "info" : "outline"}>
            {filteredTotal} open
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {visibleOpen.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No open positions for the selected strategies. The F&amp;O
            paper-trader opens a position automatically when a fresh
            signal from an active strategy fires.
          </p>
        ) : pageItems.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No positions match the current filter.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]" data-density="compact">
              <table className="w-full text-[12px]">
                <thead className="bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                  <tr>
                    <Th>Symbol</Th>
                    <Th>Strategy</Th>
                    <Th>Side</Th>
                    <Th align="right">Entry</Th>
                    <Th align="right">Mark</Th>
                    <Th align="right">Stop</Th>
                    <Th align="right">Target</Th>
                    <Th align="right">RR</Th>
                    <Th align="right">P&amp;L %</Th>
                    <Th align="right">P&amp;L ₹</Th>
                    <Th align="right">Opened</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((t) => {
                    const mark = prices[t.symbol];
                    const live = computeIndiaLivePnl(t, mark);
                    return (
                      <tr
                        key={t.id}
                        className={cn(
                          "border-t border-[var(--color-border)]",
                          live && live.pct >= 5 && "row-positive-border",
                          live && live.pct <= -3 && "row-negative-border",
                        )}
                        style={
                          live
                            ? {
                                borderLeft: live.pct >= 5
                                  ? "2px solid var(--color-data-positive)"
                                  : live.pct <= -3
                                  ? "2px solid var(--color-data-negative)"
                                  : undefined,
                              }
                            : undefined
                        }
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
                          <Badge
                            variant={t.direction === "LONG" ? "bull" : "bear"}
                          >
                            {t.direction}
                          </Badge>
                        </Td>
                        <Td align="right">₹{fmt(t.entry, 2)}</Td>
                        <Td align="right">
                          {mark !== undefined ? (
                            <NumberMorph value={mark} prefix="₹" decimals={2} />
                          ) : "—"}
                        </Td>
                        <Td align="right">₹{fmt(t.stopLoss, 2)}</Td>
                        <Td align="right">₹{fmt(t.target, 2)}</Td>
                        <Td align="right">{t.riskReward.toFixed(2)}</Td>
                        <Td align="right" style={{ color: (live?.pct ?? 0) >= 0 ? "var(--color-data-positive)" : "var(--color-data-negative)" }}>
                          {live
                            ? `${live.pct > 0 ? "+" : ""}${live.pct.toFixed(2)}%`
                            : "—"}
                        </Td>
                        <Td align="right" style={{ color: (live?.usd ?? 0) >= 0 ? "var(--color-data-positive)" : "var(--color-data-negative)" }}>
                          {live
                            ? `${live.usd > 0 ? "+" : ""}₹${live.usd.toFixed(2)}`
                            : "—"}
                        </Td>
                        <Td align="right" className="text-[var(--color-fg-subtle)]">
                          {fmtDateTime(t.openedAt)}
                        </Td>
                        <Td align="right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void cancelTrade(t.id)}
                          >
                            Cancel
                          </Button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationStrip
              page={page}
              totalPages={totalPages}
              filteredTotal={filteredTotal}
              pageSize={pageSize}
              onPrev={() => setPage(page - 1)}
              onNext={() => setPage(page + 1)}
              onJump={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
