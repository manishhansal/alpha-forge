"use client";

import * as React from "react";
import { PieChart, BarChart3, TrendingUp, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OptMethod = "hrp" | "cvar" | "max_diversification" | "factor";

interface RiskMetrics {
  volatility: number;
  cvar: number;
  sharpe: number;
  maxDrawdown: number;
}

interface EfficientFrontierPoint {
  risk: number;
  return: number;
}

interface PortfolioAllocation {
  method: OptMethod;
  weights: Record<string, number>;
  riskMetrics: RiskMetrics;
  efficientFrontier?: EfficientFrontierPoint[];
  available: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// F&O universe (top NSE F&O names for the multi-select)
// ---------------------------------------------------------------------------

const FNO_UNIVERSE = [
  "RELIANCE",
  "TCS",
  "INFY",
  "HDFCBANK",
  "ICICIBANK",
  "WIPRO",
  "LT",
  "ONGC",
  "SBIN",
  "AXISBANK",
  "BAJFINANCE",
  "MARUTI",
  "TATAMOTORS",
  "ADANIPORTS",
  "NTPC",
];

const METHODS: { value: OptMethod; label: string; description: string }[] = [
  {
    value: "hrp",
    label: "HRP",
    description: "Hierarchical Risk Parity",
  },
  {
    value: "cvar",
    label: "CVaR",
    description: "Conditional Value-at-Risk (α=0.05)",
  },
  {
    value: "max_diversification",
    label: "Max Diversification",
    description: "Maximum Diversification Ratio",
  },
  {
    value: "factor",
    label: "Factor",
    description: "NIFTY Beta-Neutral Factor",
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Shown when the ML service is unavailable. */
function UnavailableBadge({ reason }: { reason?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-hover)]">
        <AlertCircle className="h-6 w-6 text-[var(--color-fg-muted)]" />
      </div>
      <div>
        <p className="text-sm font-medium text-[var(--color-fg)]">
          Portfolio Optimizer Unavailable
        </p>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          {reason ?? "ML service is offline. Start the ML service to use this feature."}
        </p>
      </div>
      <Badge variant="warning">ML Service Offline</Badge>
    </div>
  );
}

/** Allocation pie chart — simple CSS-based visual (no external charting lib). */
function AllocationPieChart({ weights }: { weights: Record<string, number> }) {
  const entries = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (entries.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-[var(--color-fg-muted)]">
        No allocation data.
      </p>
    );
  }

  const COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
    "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
  ];

  // Build conic-gradient stops
  const stops = entries.reduce<{ list: string[]; cursor: number }>(
    ({ list, cursor }, [, w], i) => {
      const start = cursor;
      const next = cursor + w * 100;
      return {
        list: [...list, `${COLORS[i % COLORS.length]} ${start.toFixed(1)}% ${next.toFixed(1)}%`],
        cursor: next,
      };
    },
    { list: [], cursor: 0 },
  ).list;

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        aria-label="Allocation pie chart"
        style={{
          width: 160,
          height: 160,
          borderRadius: "50%",
          background: `conic-gradient(${stops.join(", ")})`,
        }}
      />
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {entries.map(([symbol, weight], i) => (
          <li key={symbol} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <span className="font-medium text-[var(--color-fg)]">{symbol}</span>
            <span className="text-[var(--color-fg-muted)]">
              {(weight * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Efficient frontier scatter — simple SVG-based chart. */
function EfficientFrontierChart({
  points,
}: {
  points: EfficientFrontierPoint[];
}) {
  if (!points || points.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-[var(--color-fg-muted)]">
        No efficient frontier data.
      </p>
    );
  }

  const W = 360;
  const H = 200;
  const PAD = 32;

  const risks = points.map((p) => p.risk);
  const returns = points.map((p) => p.return);
  const minR = Math.min(...risks);
  const maxR = Math.max(...risks);
  const minY = Math.min(...returns);
  const maxY = Math.max(...returns);

  const toX = (r: number) =>
    PAD + ((r - minR) / (maxR - minR || 1)) * (W - 2 * PAD);
  const toY = (ret: number) =>
    H - PAD - ((ret - minY) / (maxY - minY || 1)) * (H - 2 * PAD);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      aria-label="Efficient frontier scatter chart"
      className="overflow-visible"
    >
      {/* Axes */}
      <line
        x1={PAD} y1={PAD} x2={PAD} y2={H - PAD}
        stroke="var(--color-border)" strokeWidth={1}
      />
      <line
        x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD}
        stroke="var(--color-border)" strokeWidth={1}
      />
      {/* Axis labels */}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={9}
        fill="var(--color-fg-muted)">Risk</text>
      <text x={10} y={H / 2} textAnchor="middle" fontSize={9}
        fill="var(--color-fg-muted)"
        transform={`rotate(-90, 10, ${H / 2})`}>Return</text>
      {/* Data points */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={toX(p.risk)}
          cy={toY(p.return)}
          r={4}
          fill="#3b82f6"
          opacity={0.7}
        >
          <title>{`Risk: ${(p.risk * 100).toFixed(2)}% | Return: ${(p.return * 100).toFixed(2)}%`}</title>
        </circle>
      ))}
    </svg>
  );
}

/** Risk metrics summary table. */
function RiskMetricsTable({ metrics }: { metrics: RiskMetrics }) {
  const rows = [
    {
      label: "Sharpe Ratio",
      value: metrics.sharpe.toFixed(2),
      positive: metrics.sharpe > 1,
    },
    {
      label: "CVaR (95%)",
      value: `${(metrics.cvar * 100).toFixed(2)}%`,
      positive: metrics.cvar < 0.05,
    },
    {
      label: "Volatility (Ann.)",
      value: `${(metrics.volatility * 100).toFixed(2)}%`,
      positive: metrics.volatility < 0.2,
    },
    {
      label: "Max Drawdown",
      value: `${(metrics.maxDrawdown * 100).toFixed(2)}%`,
      positive: metrics.maxDrawdown < 0.15,
    },
  ];

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          <th className="pb-2 text-left font-medium">Metric</th>
          <th className="pb-2 text-right font-medium">Value</th>
          <th className="pb-2 text-right font-medium">Signal</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.label}
            className="border-b border-[var(--color-border)] last:border-0"
          >
            <td className="py-2.5 text-[var(--color-fg-muted)]">{row.label}</td>
            <td className="py-2.5 text-right font-medium tabular-nums text-[var(--color-fg)]">
              {row.value}
            </td>
            <td className="py-2.5 text-right">
              <Badge variant={row.positive ? "bull" : "bear"}>
                {row.positive ? "Good" : "Elevated"}
              </Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PortfolioOptimizerPage() {
  const [selectedSymbols, setSelectedSymbols] = React.useState<string[]>([
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "ICICIBANK",
  ]);
  const [method, setMethod] = React.useState<OptMethod>("hrp");
  const [result, setResult] = React.useState<PortfolioAllocation | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function toggleSymbol(sym: string) {
    setSelectedSymbols((prev) =>
      prev.includes(sym) ? prev.filter((s) => s !== sym) : [...prev, sym],
    );
  }

  async function handleOptimize() {
    if (selectedSymbols.length < 2) {
      setError("Select at least 2 symbols to optimise.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/in/portfolio-optimizer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: selectedSymbols, method }),
      });
      const data = (await res.json()) as PortfolioAllocation;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      {/* ── Page header ── */}
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Portfolio Optimizer
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Institutional-grade NSE F&amp;O portfolio construction — HRP,
          CVaR-constrained MVO, Maximum Diversification, and Factor models
          powered by Riskfolio-Lib.
        </p>
      </header>

      {/* ── Controls card ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            <BarChart3 className="h-4 w-4" />
            Configure Optimisation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {/* Symbol multi-select */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
              Symbol Selection
              <span className="ml-2 font-normal normal-case">
                ({selectedSymbols.length} selected)
              </span>
            </p>
            <div
              role="group"
              aria-label="F&O symbol multi-select"
              className="flex flex-wrap gap-1.5"
            >
              {FNO_UNIVERSE.map((sym) => {
                const active = selectedSymbols.includes(sym);
                return (
                  <button
                    key={sym}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleSymbol(sym)}
                    className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? "border-[var(--color-brand)] bg-[color-mix(in_oklch,var(--color-brand)_15%,transparent)] text-[var(--color-brand)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-fg-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
                    }`}
                  >
                    {sym}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Method selector */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
              Optimisation Method
            </p>
            <div
              role="radiogroup"
              aria-label="Optimisation method selector"
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {METHODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={method === m.value}
                  onClick={() => setMethod(m.value)}
                  className={`flex flex-col rounded-lg border p-3 text-left transition-colors ${
                    method === m.value
                      ? "border-[var(--color-brand)] bg-[color-mix(in_oklch,var(--color-brand)_10%,transparent)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <span className="text-xs font-semibold text-[var(--color-fg)]">
                    {m.label}
                  </span>
                  <span className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                    {m.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Validation error */}
          {error && (
            <p className="rounded-lg border border-[color-mix(in_oklch,var(--color-bear)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-bear)]">
              {error}
            </p>
          )}

          <Button
            variant="primary"
            size="md"
            onClick={handleOptimize}
            disabled={loading || selectedSymbols.length < 2}
            className="self-start"
          >
            {loading ? "Optimising…" : "Run Optimisation"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Results ── */}
      {result !== null && (
        result.available ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Allocation pie */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                  <PieChart className="h-4 w-4" />
                  Allocation
                  <Badge variant="neutral" className="ml-auto">
                    {METHODS.find((m) => m.value === result.method)?.label ?? result.method}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <AllocationPieChart weights={result.weights} />
              </CardContent>
            </Card>

            {/* Risk metrics */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                  <TrendingUp className="h-4 w-4" />
                  Risk Metrics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RiskMetricsTable metrics={result.riskMetrics} />
              </CardContent>
            </Card>

            {/* Efficient frontier */}
            {result.efficientFrontier && result.efficientFrontier.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                    Efficient Frontier
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <EfficientFrontierChart points={result.efficientFrontier} />
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          /* ML service offline — graceful empty state */
          <Card>
            <CardContent>
              <UnavailableBadge reason={result.reason} />
            </CardContent>
          </Card>
        )
      )}

      {/* ── How it works ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            How the optimizer works
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)] sm:grid-cols-2">
            <li>
              <span className="font-semibold text-[var(--color-fg)]">HRP</span>{" "}
              — Hierarchical Risk Parity builds a dendrogram of return
              correlations and allocates inverse-variance weights at each
              node, avoiding matrix inversion entirely.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">CVaR</span>{" "}
              — Conditional Value-at-Risk MVO minimises the expected loss in
              the worst 5% of outcomes, producing a tail-risk-aware portfolio.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Max Diversification
              </span>{" "}
              — Maximises the diversification ratio (weighted avg vol /
              portfolio vol), ensuring no single factor dominates.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">Factor</span>{" "}
              — Beta-neutralises against NIFTY and allocates residual risk
              using a multi-factor model (momentum, quality, low-vol).
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
