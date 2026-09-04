"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Layers,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataSourceBadge } from "@/components/india/DataSourceBadge";
import type {
  IndiaSignalCenterResponse,
  OpportunityCluster,
  UnifiedIndiaSignal,
} from "@/lib/india-signal-center/types";

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchSignalCenter(): Promise<IndiaSignalCenterResponse> {
  const res = await fetch("/api/in/signal-center", { cache: "no-store" });
  if (!res.ok) throw new Error(`Signal center: HTTP ${res.status}`);
  return res.json() as Promise<IndiaSignalCenterResponse>;
}

// ── Grade badge ───────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<string, string> = {
  S: "bg-emerald-500 text-white",
  A: "bg-green-500 text-white",
  B: "bg-blue-500 text-white",
  C: "bg-yellow-500 text-black",
  D: "bg-orange-500 text-white",
  F: "bg-red-500 text-white",
};

function GradeBadge({ grade }: { grade: string }) {
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${GRADE_COLOR[grade] ?? "bg-muted text-muted-foreground"}`}
    >
      {grade}
    </span>
  );
}

// ── Direction icon ────────────────────────────────────────────────────────────

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "LONG")
    return <TrendingUp className="h-4 w-4 text-emerald-500" />;
  if (direction === "SHORT")
    return <TrendingDown className="h-4 w-4 text-red-400" />;
  return <Activity className="h-4 w-4 text-muted-foreground" />;
}

// ── Signal quality bar ────────────────────────────────────────────────────────

function QualityBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color =
    pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-[var(--color-border)]">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-[var(--color-fg-muted)]">{pct}</span>
    </div>
  );
}

// ── Cluster card ─────────────────────────────────────────────────────────────

function ClusterCard({ cluster }: { cluster: OpportunityCluster }) {
  const [expanded, setExpanded] = React.useState(false);
  const { primarySignal: sig } = cluster;

  return (
    <Card className="overflow-hidden border-[var(--color-border)]">
      <CardContent className="p-0">
        {/* Primary row */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-3 p-4 text-left hover:bg-[var(--color-surface-raised)] transition-colors"
          aria-expanded={expanded}
        >
          <DirectionIcon direction={sig.direction} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">{sig.displayName}</span>
              <GradeBadge grade={sig.grade} />
              {cluster.independentConfirmations > 1 && (
                <Badge variant="outline" className="text-[10px] h-4 px-1">
                  <Layers className="mr-0.5 h-2.5 w-2.5" />
                  {cluster.independentConfirmations} confirmations
                </Badge>
              )}
            </div>
            <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
              {sig.sourceAttribution} · {sig.timeframe}
            </div>
          </div>

          <div className="shrink-0 text-right">
            {sig.entry != null && (
              <div className="text-xs font-mono">
                ₹{sig.entry.toLocaleString("en-IN")}
              </div>
            )}
            {sig.riskReward != null && (
              <div className="text-[10px] text-[var(--color-fg-muted)]">
                RR {sig.riskReward.toFixed(1)}
              </div>
            )}
          </div>

          <div className="shrink-0">
            <QualityBar score={sig.qualityScore} />
          </div>

          <div className="shrink-0 text-[var(--color-fg-muted)]">
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="border-t border-[var(--color-border)] p-4 space-y-3">
            {/* Levels */}
            {(sig.entry != null || sig.stopLoss != null || sig.tp1 != null) && (
              <div className="grid grid-cols-4 gap-2 text-xs">
                {sig.entry != null && (
                  <div>
                    <div className="text-[var(--color-fg-muted)]">Entry</div>
                    <div className="font-mono font-medium">
                      ₹{sig.entry.toLocaleString("en-IN")}
                    </div>
                  </div>
                )}
                {sig.stopLoss != null && (
                  <div>
                    <div className="text-[var(--color-fg-muted)]">SL</div>
                    <div className="font-mono font-medium text-red-400">
                      ₹{sig.stopLoss.toLocaleString("en-IN")}
                    </div>
                  </div>
                )}
                {sig.tp1 != null && (
                  <div>
                    <div className="text-[var(--color-fg-muted)]">TP1</div>
                    <div className="font-mono font-medium text-emerald-500">
                      ₹{sig.tp1.toLocaleString("en-IN")}
                    </div>
                  </div>
                )}
                {sig.tp3 != null && (
                  <div>
                    <div className="text-[var(--color-fg-muted)]">TP3</div>
                    <div className="font-mono font-medium text-emerald-400">
                      ₹{sig.tp3.toLocaleString("en-IN")}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Confirmations */}
            {cluster.allSignals.length > 1 && (
              <div>
                <div className="text-[10px] text-[var(--color-fg-muted)] mb-1 uppercase tracking-wide">
                  Confirmations ({cluster.allSignals.length})
                </div>
                <div className="flex flex-wrap gap-1">
                  {cluster.allSignals.map((s) => (
                    <Badge
                      key={s.id}
                      variant="outline"
                      className="text-[10px]"
                    >
                      {s.signalFamily} · {s.strategy}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Data quality + lineage */}
            <div className="flex items-center gap-4 text-[10px] text-[var(--color-fg-muted)]">
              <span>Data quality: {sig.dataQualityScore}</span>
              {sig.dataProvider && <span>Provider: {sig.dataProvider}</span>}
              {sig.dataObservationId && (
                <span className="font-mono opacity-50">
                  obs:{sig.dataObservationId.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({
  stats,
}: {
  stats: IndiaSignalCenterResponse["stats"];
}) {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-[var(--color-fg-muted)]">
      <span>
        <strong className="text-[var(--color-fg)]">{stats.generated}</strong>{" "}
        generated
      </span>
      <span>
        <strong className="text-emerald-500">{stats.approved}</strong> approved
      </span>
      <span>
        <strong className="text-amber-400">{stats.clustered}</strong> clustered
      </span>
      <span>
        <strong className="text-red-400">{stats.rejected}</strong> rejected
      </span>
      <span>
        <strong className="text-[var(--color-fg-muted)]">
          {stats.abstained}
        </strong>{" "}
        abstained
      </span>
      {stats.paperExecuted > 0 && (
        <span>
          <strong className="text-blue-400">{stats.paperExecuted}</strong> paper
          trades
        </span>
      )}
    </div>
  );
}

// ── Provider status row ───────────────────────────────────────────────────────

function ProviderStatusRow({
  providers,
}: {
  providers: IndiaSignalCenterResponse["dataProviders"];
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {providers.map((p) => (
        <div key={p.providerId} className="flex items-center gap-1.5 text-xs">
          {p.available ? (
            <Wifi className="h-3 w-3 text-emerald-500" />
          ) : (
            <WifiOff className="h-3 w-3 text-red-400" />
          )}
          <span
            className={
              p.available
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-muted)]"
            }
          >
            {p.providerId}
          </span>
          {p.available && p.latencyMs != null && (
            <span className="text-[var(--color-fg-muted)]">
              {p.latencyMs}ms
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Regime badge ──────────────────────────────────────────────────────────────

function RegimeBadge({ regime }: { regime: string }) {
  const colorMap: Record<string, string> = {
    TRENDING_BULLISH: "text-emerald-500",
    TRENDING_BEARISH: "text-red-400",
    RANGE_BOUND: "text-amber-400",
    HIGH_VOLATILITY: "text-orange-400",
    LOW_VOLATILITY: "text-blue-400",
    TRANSITION: "text-purple-400",
    UNKNOWN: "text-[var(--color-fg-muted)]",
  };
  return (
    <span className={`text-xs font-medium ${colorMap[regime] ?? ""}`}>
      {regime.replace(/_/g, " ")}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function IndiaSignalCenter() {
  const [filter, setFilter] = React.useState<"ALL" | "LONG" | "SHORT">("ALL");

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery<
    IndiaSignalCenterResponse,
    Error
  >({
    queryKey: ["india-signal-center"],
    queryFn: fetchSignalCenter,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-[var(--color-fg-muted)]">
        <Activity className="mr-2 h-5 w-5 animate-pulse" />
        Loading signal center…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {error?.message ?? "Failed to load signal center."}
      </div>
    );
  }

  const clusters = data.topOpportunities.filter(
    (c) =>
      filter === "ALL" ||
      (filter === "LONG" && c.primarySignal.direction === "LONG") ||
      (filter === "SHORT" && c.primarySignal.direction === "SHORT"),
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Market Context */}
      <Card className="border-[var(--color-border)]">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">
              Market Regime
            </CardTitle>
            <div className="flex items-center gap-3">
              {data.marketOpen ? (
                <span className="flex items-center gap-1 text-xs text-emerald-500">
                  <CheckCircle className="h-3 w-3" />
                  Market Open
                </span>
              ) : (
                <span className="text-xs text-[var(--color-fg-muted)]">
                  Market Closed
                </span>
              )}
              <button
                type="button"
                onClick={() => void refetch()}
                className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
                title="Refresh"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <div>
              <span className="text-xs text-[var(--color-fg-muted)]">Regime</span>
              <div className="mt-0.5">
                <RegimeBadge regime={data.regime} />
              </div>
            </div>
            {data.niftyLevel != null && (
              <div>
                <span className="text-xs text-[var(--color-fg-muted)]">NIFTY</span>
                <div className="mt-0.5 font-mono text-sm font-semibold">
                  {data.niftyLevel.toLocaleString("en-IN")}
                  {data.niftyChangePct != null && (
                    <span
                      className={`ml-1.5 text-xs ${data.niftyChangePct >= 0 ? "text-emerald-500" : "text-red-400"}`}
                    >
                      {data.niftyChangePct >= 0 ? "+" : ""}
                      {data.niftyChangePct.toFixed(2)}%
                    </span>
                  )}
                </div>
              </div>
            )}
            {data.bankNiftyLevel != null && (
              <div>
                <span className="text-xs text-[var(--color-fg-muted)]">BANKNIFTY</span>
                <div className="mt-0.5 font-mono text-sm font-semibold">
                  {data.bankNiftyLevel.toLocaleString("en-IN")}
                </div>
              </div>
            )}
            {data.vixLevel != null && (
              <div>
                <span className="text-xs text-[var(--color-fg-muted)]">VIX</span>
                <div className="mt-0.5 font-mono text-sm font-semibold">
                  {data.vixLevel.toFixed(2)}
                </div>
              </div>
            )}
          </div>

          {/* Provider health */}
          {data.dataProviders.length > 0 && (
            <ProviderStatusRow providers={data.dataProviders} />
          )}

          {/* Stats */}
          <StatsBar stats={data.stats} />

          <div className="text-[10px] text-[var(--color-fg-muted)]">
            Updated {new Date(dataUpdatedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST
          </div>
        </CardContent>
      </Card>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-fg-muted)]">Direction:</span>
        {(["ALL", "LONG", "SHORT"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === f
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="ml-auto text-xs text-[var(--color-fg-muted)]">
          {clusters.length} opportunit{clusters.length === 1 ? "y" : "ies"}
        </span>
        <DataSourceBadge />
      </div>

      {/* Top Opportunities */}
      {clusters.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center text-sm text-[var(--color-fg-muted)]">
          {data.marketOpen
            ? "No actionable opportunities at this time."
            : "Market is closed. Opportunities will appear during trading hours (09:15–15:30 IST)."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-xs font-medium text-[var(--color-fg-muted)] uppercase tracking-wide">
            Top Opportunities
          </div>
          {clusters.map((cluster) => (
            <ClusterCard key={cluster.clusterId} cluster={cluster} />
          ))}
        </div>
      )}

      {/* Rejected signals */}
      {data.rejected.length > 0 && (
        <div className="mt-2">
          <details className="group">
            <summary className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
              <ChevronRight className="h-3 w-3 group-open:rotate-90 transition-transform" />
              {data.rejected.length} rejected / abstained signals
            </summary>
            <div className="mt-2 flex flex-col gap-1.5 pl-5">
              {data.rejected.slice(0, 10).map((sig: UnifiedIndiaSignal) => (
                <div
                  key={sig.id}
                  className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]"
                >
                  <span className="font-medium text-[var(--color-fg)]">
                    {sig.symbol}
                  </span>
                  <span className="opacity-60">
                    {sig.direction} · {sig.signalFamily}
                  </span>
                  <span className="ml-auto opacity-50">
                    {sig.rejectionReason ?? sig.abstentionReason ?? "unknown"}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
