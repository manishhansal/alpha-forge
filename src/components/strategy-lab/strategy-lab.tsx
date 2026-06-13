"use client";

import { Sparkles, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ResultPanel } from "@/components/strategy-lab/result-panel";
import { cn } from "@/lib/utils";
import type {
  BacktestResult,
  ParsedStrategy,
  StrategyPeriod,
} from "@/features/strategy-lab/types";
import { PERIOD_LABEL, STRATEGY_PERIODS } from "@/features/strategy-lab/types";
import type { SymbolId } from "@/types/market";

interface SavedStrategy {
  id: string;
  name: string;
  prompt: string;
  parsed: ParsedStrategy;
  symbols: SymbolId[];
  liveEnabled: boolean;
  liveStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PaperTrade {
  id: string;
  symbol: SymbolId;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "WIN" | "LOSS" | "EXPIRED" | "CANCELLED";
  entry: number;
  stopLoss: number;
  target: number;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  closeReason: string | null;
  openedAt: number;
  closedAt: number | null;
}

interface LiveStats {
  totalTrades: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  cancelled: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlPct: number;
}

const SYMBOLS: SymbolId[] = ["BTC", "ETH", "SOL"];

const PROMPT_EXAMPLES = [
  "Buy when RSI drops below 30 and sell when RSI crosses above 70. Stop loss 2%, take profit 5%.",
  "Long when EMA(20) crosses above EMA(50). Exit when EMA(20) crosses below EMA(50). Stop 3%.",
  "Buy when MACD histogram turns positive and volume above 1.5x average. Stop 2%, take profit 4%.",
  "Short when price drops 4% in 4 hours. Take profit 3%, stop loss 2%.",
];

export function StrategyLab() {
  const [prompt, setPrompt] = useState<string>(PROMPT_EXAMPLES[0]);
  const [symbol, setSymbol] = useState<SymbolId>("BTC");
  const [period, setPeriod] = useState<StrategyPeriod>("6M");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [strategies, setStrategies] = useState<SavedStrategy[]>([]);
  const [strategiesLoading, setStrategiesLoading] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null);

  const refreshStrategies = useCallback(async () => {
    setStrategiesLoading(true);
    try {
      const res = await fetch("/api/strategy-lab/strategies", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { items: SavedStrategy[] };
      setStrategies(json.items);
    } finally {
      setStrategiesLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void refreshStrategies(), 0);
    return () => clearTimeout(t);
  }, [refreshStrategies]);

  const runBacktest = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/strategy-lab/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          symbol,
          period,
          strategyId: activeStrategyId ?? undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError((json as { message?: string }).message ?? "Backtest failed.");
        setResult(null);
        return;
      }
      setResult(json as BacktestResult);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [prompt, symbol, period, activeStrategyId]);

  const saveStrategy = useCallback(async () => {
    const name = savedName.trim() || prompt.slice(0, 40);
    setError(null);
    try {
      const res = await fetch("/api/strategy-lab/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, symbols: [symbol] }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError((json as { message?: string }).message ?? "Save failed.");
        return;
      }
      setSavedName("");
      setActiveStrategyId((json as SavedStrategy).id);
      await refreshStrategies();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [savedName, prompt, symbol, refreshStrategies]);

  const loadStrategy = useCallback((s: SavedStrategy) => {
    setPrompt(s.prompt);
    setSymbol(s.symbols[0] ?? "BTC");
    setActiveStrategyId(s.id);
    setResult(null);
  }, []);

  const newStrategy = useCallback(() => {
    setActiveStrategyId(null);
    setResult(null);
    setSavedName("");
  }, []);

  const toggleLive = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await fetch(`/api/strategy-lab/strategies/${id}/live`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        await refreshStrategies();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refreshStrategies],
  );

  const deleteStrategy = useCallback(
    async (id: string) => {
      if (!confirm("Delete this strategy and its paper trades?")) return;
      try {
        await fetch(`/api/strategy-lab/strategies/${id}`, { method: "DELETE" });
        if (activeStrategyId === id) setActiveStrategyId(null);
        await refreshStrategies();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [activeStrategyId, refreshStrategies],
  );

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === activeStrategyId) ?? null,
    [strategies, activeStrategyId],
  );

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                {activeStrategy ? `Editing: ${activeStrategy.name}` : "Describe your strategy"}
              </CardTitle>
              <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
                Plain English. Mention indicators (RSI, MACD, EMA, ATR), price moves, and your
                stop / target.
              </p>
            </div>
            {activeStrategy ? (
              <Button size="sm" variant="ghost" onClick={newStrategy}>
                + New
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="e.g. Buy BTC when RSI drops below 30 and sell when RSI crosses above 70. Stop loss 2%, take profit 5%."
              className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] leading-relaxed text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-border-strong)] focus:outline-none"
            />

            <div className="flex flex-wrap items-end gap-3">
              <FilterSelect
                label="Symbol"
                value={symbol}
                onChange={(v) => setSymbol(v as SymbolId)}
                options={SYMBOLS}
              />
              <FilterSelect
                label="Period"
                value={period}
                onChange={(v) => setPeriod(v as StrategyPeriod)}
                options={STRATEGY_PERIODS as unknown as string[]}
                renderOption={(o) => `${o} · ${PERIOD_LABEL[o as StrategyPeriod]}`}
              />
              <div className="ml-auto flex items-center gap-2">
                <Button onClick={() => void runBacktest()} disabled={running}>
                  <Sparkles className="h-4 w-4" />
                  {running ? "Running…" : "Run backtest"}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-1 flex-col gap-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                  Examples
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {PROMPT_EXAMPLES.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-left text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
                      onClick={() => setPrompt(p)}
                    >
                      {p.length > 90 ? `${p.slice(0, 90)}…` : p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {!activeStrategy ? (
              <div className="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
                <Input
                  value={savedName}
                  onChange={(e) => setSavedName(e.target.value)}
                  placeholder="Strategy name (optional)"
                  className="max-w-[260px]"
                />
                <Button variant="secondary" onClick={() => void saveStrategy()}>
                  Save strategy
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
                <Badge variant={activeStrategy.liveEnabled ? "info" : "outline"}>
                  {activeStrategy.liveEnabled ? "Live · paper trading" : "Paused"}
                </Badge>
                <Button
                  size="sm"
                  variant={activeStrategy.liveEnabled ? "danger" : "primary"}
                  onClick={() => void toggleLive(activeStrategy.id, !activeStrategy.liveEnabled)}
                >
                  <Zap className="h-3.5 w-3.5" />
                  {activeStrategy.liveEnabled ? "Stop live" : "Apply to current market"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void deleteStrategy(activeStrategy.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>
            )}

            {error ? (
              <p className="rounded-lg border border-[var(--color-bear)]/30 bg-[color-mix(in_oklch,var(--color-bear)_8%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]">
                {error}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {running ? (
          <Skeleton className="h-[480px] w-full rounded-xl" />
        ) : result ? (
          <ResultPanel result={result} />
        ) : (
          <Card>
            <CardContent className="py-10 text-center text-[12px] text-[var(--color-fg-muted)]">
              Run a backtest to see win rate, drawdown, equity curve, and the full trade log.
            </CardContent>
          </Card>
        )}

        {activeStrategyId ? <LiveTrades strategyId={activeStrategyId} /> : null}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
              Saved strategies
            </CardTitle>
          </CardHeader>
          <CardContent>
            {strategiesLoading ? (
              <Skeleton className="h-[120px] w-full rounded-lg" />
            ) : strategies.length === 0 ? (
              <p className="text-[12px] text-[var(--color-fg-muted)]">
                Save a strategy to track it across backtests and live paper trading.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {strategies.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => loadStrategy(s)}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
                        activeStrategyId === s.id
                          ? "border-[var(--color-brand)]/60 bg-[color-mix(in_oklch,var(--color-brand)_6%,var(--color-bg-elevated))]"
                          : "border-[var(--color-border)] bg-[var(--color-bg-elevated)] hover:bg-[var(--color-surface)]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[var(--color-fg)]">
                          {s.name}
                        </span>
                        <Badge variant={s.liveEnabled ? "info" : "outline"}>
                          {s.liveEnabled ? "live" : "paused"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--color-fg-subtle)]">
                        {s.symbols.map((sy) => (
                          <span key={sy}>{sy}</span>
                        ))}
                        <span>· {new Date(s.updatedAt).toLocaleDateString()}</span>
                      </div>
                      <p className="line-clamp-2 text-[11px] text-[var(--color-fg-muted)]">
                        {s.prompt}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
              Tips for clearer prompts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Indicators.</span> RSI(N),
                MACD line / signal / histogram, EMA(N), SMA(N), ATR(N), price, volume.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Comparators.</span> Use
                &quot;above / below&quot;, &quot;crosses above / below&quot;, or symbols like
                <code className="font-mono"> &lt; &gt; ≥ ≤</code>.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Price moves.</span>{" "}
                &quot;drops 5% in 4 hours&quot; or &quot;rises 3% in 1 day&quot; map to a
                window-percent change condition.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Risk.</span> Specify a stop
                with &quot;stop loss 2%&quot; or &quot;stop 1.5x ATR&quot;, and target via
                &quot;take profit 5%&quot; or &quot;target 3x ATR&quot;.
              </li>
              <li>
                <span className="font-semibold text-[var(--color-fg)]">Live mode.</span> When you
                press &quot;Apply to current market&quot;, the worker evaluates the rule on every
                fresh hourly bar and opens paper trades — no real funds touched.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function LiveTrades({ strategyId }: { strategyId: string }) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/strategy-lab/strategies/${strategyId}/trades`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { trades: PaperTrade[]; stats: LiveStats };
      setTrades(json.trades);
      setStats(json.stats);
    } finally {
      setLoading(false);
    }
  }, [strategyId]);

  useEffect(() => {
    const initialT = setTimeout(() => void fetchTrades(), 0);
    const id = setInterval(fetchTrades, 30_000);
    return () => {
      clearTimeout(initialT);
      clearInterval(id);
    };
  }, [fetchTrades]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Live paper trading
          </CardTitle>
          <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">
            {loading ? "Refreshing…" : "Refreshes every 30s"}
          </p>
        </div>
        {stats ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Badge variant="outline">{stats.totalTrades} trades</Badge>
            <Badge variant={stats.totalPnlUsd >= 0 ? "bull" : "bear"}>
              {stats.totalPnlUsd >= 0 ? "+" : ""}${stats.totalPnlUsd.toFixed(2)}
            </Badge>
            <Badge variant={stats.winRate >= 0.5 ? "bull" : "outline"}>
              {(stats.winRate * 100).toFixed(0)}% win
            </Badge>
            <Badge variant="info">{stats.open} open</Badge>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {trades.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No paper trades fired yet. The worker evaluates active strategies once a minute on
            the hourly bar — fresh entries will appear here as soon as your rule triggers.
          </p>
        ) : (
          <div className="max-h-[280px] overflow-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)]">
                <tr>
                  <Th>Symbol</Th>
                  <Th>Side</Th>
                  <Th>Status</Th>
                  <Th align="right">Entry</Th>
                  <Th align="right">Exit</Th>
                  <Th align="right">P&amp;L %</Th>
                  <Th align="right">Opened</Th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--color-border)]">
                    <Td>
                      <span className="font-semibold">{t.symbol}</span>
                    </Td>
                    <Td>
                      <Badge variant={t.direction === "LONG" ? "bull" : "bear"}>
                        {t.direction}
                      </Badge>
                    </Td>
                    <Td>{statusBadge(t.status)}</Td>
                    <Td align="right">${t.entry.toFixed(2)}</Td>
                    <Td align="right">
                      {t.exitPrice !== null ? `$${t.exitPrice.toFixed(2)}` : "—"}
                    </Td>
                    <Td
                      align="right"
                      className={
                        t.pnlPct === null
                          ? "text-[var(--color-fg-muted)]"
                          : t.pnlPct > 0
                            ? "text-[var(--color-bull)]"
                            : t.pnlPct < 0
                              ? "text-[var(--color-bear)]"
                              : "text-[var(--color-fg-muted)]"
                      }
                    >
                      {t.pnlPct !== null
                        ? `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%`
                        : "—"}
                    </Td>
                    <Td align="right" className="text-[var(--color-fg-subtle)]">
                      {new Date(t.openedAt).toLocaleString()}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function statusBadge(status: PaperTrade["status"]) {
  switch (status) {
    case "OPEN":
      return <Badge variant="info">Open</Badge>;
    case "WIN":
      return <Badge variant="bull">Win</Badge>;
    case "LOSS":
      return <Badge variant="bear">Loss</Badge>;
    case "EXPIRED":
      return <Badge variant="warning">Expired</Badge>;
    case "CANCELLED":
      return <Badge variant="outline">Cancelled</Badge>;
  }
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  renderOption,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  renderOption?: (o: string) => string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-fg)]"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {renderOption ? renderOption(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em]",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-3 py-2",
        align === "right" ? "text-right num" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}
