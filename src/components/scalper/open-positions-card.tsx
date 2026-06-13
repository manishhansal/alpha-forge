"use client";

import { useCallback, useMemo } from "react";

import {
  computeLivePnl,
  useJournalData,
  type ApiPaperTrade,
} from "@/components/scalper/journal-data-context";
import {
  StrategyChip,
  Td,
  Th,
  pnlClass,
} from "@/components/scalper/journal-shared";
import { useStrategyFilter } from "@/components/scalper/strategy-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPrice } from "@/lib/utils";

export function OpenPositionsCard() {
  const { open, prices, cancelTrade } = useJournalData();
  const { selected, timeframesFor } = useStrategyFilter();

  // Defensive client-side filter — covers SSR-prefilled rows whose
  // (strategy × timeframe) lane has since been deselected.
  const isRowSelected = useCallback(
    (t: ApiPaperTrade) =>
      selected.has(t.strategyId) && timeframesFor(t.strategyId).has(t.strategyTimeframe),
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
          Open paper positions
        </CardTitle>
        <Badge variant={visibleOpen.length > 0 ? "info" : "outline"}>
          {visibleOpen.length} open
        </Badge>
      </CardHeader>
      <CardContent>
        {visibleOpen.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No open positions for the selected strategies. The scalper opens a paper trade
            automatically when a fresh signal from an active strategy fires.
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
                  <Th align="right">P&amp;L $</Th>
                  <Th align="right">Opened</Th>
                  <Th align="right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {visibleOpen.map((t) => {
                  const mark = prices[t.symbol];
                  const live = computeLivePnl(t, mark);
                  return (
                    <tr key={t.id} className="border-t border-[var(--color-border)]">
                      <Td>
                        <span className="font-semibold">{t.symbol}</span>
                      </Td>
                      <Td>
                        <StrategyChip
                          strategyId={t.strategyId}
                          timeframe={t.strategyTimeframe}
                        />
                      </Td>
                      <Td>
                        <Badge variant={t.direction === "LONG" ? "bull" : "bear"}>
                          {t.direction}
                        </Badge>
                      </Td>
                      <Td align="right">${formatPrice(t.entry)}</Td>
                      <Td align="right">
                        {mark !== undefined ? `$${formatPrice(mark)}` : "—"}
                      </Td>
                      <Td align="right">${formatPrice(t.stopLoss)}</Td>
                      <Td align="right">${formatPrice(t.target)}</Td>
                      <Td align="right">{t.riskReward.toFixed(2)}</Td>
                      <Td align="right" className={pnlClass(live?.pct ?? null)}>
                        {live ? `${live.pct > 0 ? "+" : ""}${live.pct.toFixed(2)}%` : "—"}
                      </Td>
                      <Td align="right" className={pnlClass(live?.usd ?? null)}>
                        {live ? `${live.usd > 0 ? "+" : ""}$${live.usd.toFixed(2)}` : "—"}
                      </Td>
                      <Td align="right" className="text-[var(--color-fg-subtle)]">
                        {new Date(t.openedAt).toLocaleString()}
                      </Td>
                      <Td align="right">
                        <Button size="sm" variant="ghost" onClick={() => void cancelTrade(t.id)}>
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
