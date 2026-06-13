"use client";

import { useCallback, useMemo } from "react";

import {
  computeIndiaLivePnl,
  useIndiaJournalData,
  type ApiIndiaPaperTrade,
} from "@/components/india/paper-trading/journal-data-context";
import {
  IndiaStrategyChip,
  Td,
  Th,
  indiaPnlClass,
} from "@/components/india/paper-trading/journal-shared";
import { useIndiaStrategyFilter } from "@/components/india/strategies/strategy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt } from "@/lib/india/format";

/**
 * Live MTM table for India F&O paper trades. Visual mirror of the
 * crypto `OpenPositionsCard` — same column set, same defensive client-
 * side strategy filter so deselecting a strategy hides its OPEN trades
 * even if the server response hasn't refreshed yet.
 */
export function IndiaOpenPositionsCard() {
  const { open, prices, cancelTrade } = useIndiaJournalData();
  const { selected, timeframesFor } = useIndiaStrategyFilter();

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

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Open F&amp;O paper positions
        </CardTitle>
        <Badge variant={visibleOpen.length > 0 ? "info" : "outline"}>
          {visibleOpen.length} open
        </Badge>
      </CardHeader>
      <CardContent>
        {visibleOpen.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No open positions for the selected strategies. The F&amp;O
            paper-trader opens a position automatically when a fresh
            signal from an active strategy fires.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
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
                {visibleOpen.map((t) => {
                  const mark = prices[t.symbol];
                  const live = computeIndiaLivePnl(t, mark);
                  return (
                    <tr
                      key={t.id}
                      className="border-t border-[var(--color-border)]"
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
                        {mark !== undefined ? `₹${fmt(mark, 2)}` : "—"}
                      </Td>
                      <Td align="right">₹{fmt(t.stopLoss, 2)}</Td>
                      <Td align="right">₹{fmt(t.target, 2)}</Td>
                      <Td align="right">{t.riskReward.toFixed(2)}</Td>
                      <Td align="right" className={indiaPnlClass(live?.pct ?? null)}>
                        {live
                          ? `${live.pct > 0 ? "+" : ""}${live.pct.toFixed(2)}%`
                          : "—"}
                      </Td>
                      <Td align="right" className={indiaPnlClass(live?.usd ?? null)}>
                        {live
                          ? `${live.usd > 0 ? "+" : ""}₹${live.usd.toFixed(2)}`
                          : "—"}
                      </Td>
                      <Td align="right" className="text-[var(--color-fg-subtle)]">
                        {new Date(t.openedAt).toLocaleString()}
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
        )}
      </CardContent>
    </Card>
  );
}
