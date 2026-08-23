"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Calculator,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/india/ui/button";
import {
  computePayoff,
  aggregateGreeks,
  type OptionLeg,
  type Greeks,
} from "@/features/india/options-workbench/payoff";
import type { OptionChain, OptionChainRow } from "@/types/india";

// ---------------------------------------------------------------------------
// Strategy definitions
// ---------------------------------------------------------------------------

type StrategyId =
  | "long_call"
  | "short_call"
  | "long_put"
  | "short_put"
  | "bull_call_spread"
  | "bear_put_spread"
  | "bear_call_spread"
  | "iron_condor"
  | "straddle"
  | "strangle"
  | "butterfly"
  | "jade_lizard"
  | "custom";

interface LegTemplate {
  label: string;
  flag: "CE" | "PE";
  quantity: number; // positive = long, negative = short
}

interface StrategyDef {
  id: StrategyId;
  label: string;
  legs: LegTemplate[];
  description: string;
}

const STRATEGIES: StrategyDef[] = [
  {
    id: "long_call",
    label: "Long Call",
    legs: [{ label: "Buy Call", flag: "CE", quantity: 1 }],
    description: "Bullish — limited loss, unlimited upside",
  },
  {
    id: "short_call",
    label: "Short Call",
    legs: [{ label: "Sell Call", flag: "CE", quantity: -1 }],
    description: "Neutral/bearish — premium income, unlimited risk",
  },
  {
    id: "long_put",
    label: "Long Put",
    legs: [{ label: "Buy Put", flag: "PE", quantity: 1 }],
    description: "Bearish — limited loss, large downside profit",
  },
  {
    id: "short_put",
    label: "Short Put",
    legs: [{ label: "Sell Put", flag: "PE", quantity: -1 }],
    description: "Neutral/bullish — premium income, downside risk",
  },
  {
    id: "bull_call_spread",
    label: "Bull Call Spread",
    legs: [
      { label: "Buy Call (lower)", flag: "CE", quantity: 1 },
      { label: "Sell Call (upper)", flag: "CE", quantity: -1 },
    ],
    description: "Moderately bullish — capped profit and loss",
  },
  {
    id: "bear_put_spread",
    label: "Bear Put Spread",
    legs: [
      { label: "Buy Put (upper)", flag: "PE", quantity: 1 },
      { label: "Sell Put (lower)", flag: "PE", quantity: -1 },
    ],
    description: "Moderately bearish — capped profit and loss",
  },
  {
    id: "bear_call_spread",
    label: "Bear Call Spread",
    legs: [
      { label: "Sell Call (lower)", flag: "CE", quantity: -1 },
      { label: "Buy Call (upper)", flag: "CE", quantity: 1 },
    ],
    description: "Moderately bearish — credit spread",
  },
  {
    id: "iron_condor",
    label: "Iron Condor",
    legs: [
      { label: "Buy Put (far OTM)", flag: "PE", quantity: 1 },
      { label: "Sell Put (OTM)", flag: "PE", quantity: -1 },
      { label: "Sell Call (OTM)", flag: "CE", quantity: -1 },
      { label: "Buy Call (far OTM)", flag: "CE", quantity: 1 },
    ],
    description: "Range-bound — net credit, profit between short strikes",
  },
  {
    id: "straddle",
    label: "Straddle",
    legs: [
      { label: "Buy Call (ATM)", flag: "CE", quantity: 1 },
      { label: "Buy Put (ATM)", flag: "PE", quantity: 1 },
    ],
    description: "Volatility play — profit on big move either way",
  },
  {
    id: "strangle",
    label: "Strangle",
    legs: [
      { label: "Buy Call (OTM)", flag: "CE", quantity: 1 },
      { label: "Buy Put (OTM)", flag: "PE", quantity: 1 },
    ],
    description: "Cheaper vol play — wider strikes, wider break-evens",
  },
  {
    id: "butterfly",
    label: "Butterfly",
    legs: [
      { label: "Buy Call (lower)", flag: "CE", quantity: 1 },
      { label: "Sell 2 Calls (ATM)", flag: "CE", quantity: -2 },
      { label: "Buy Call (upper)", flag: "CE", quantity: 1 },
    ],
    description: "Neutral — max profit at ATM, limited risk",
  },
  {
    id: "jade_lizard",
    label: "Jade Lizard",
    legs: [
      { label: "Sell Put (OTM)", flag: "PE", quantity: -1 },
      { label: "Sell Call (OTM)", flag: "CE", quantity: -1 },
      { label: "Buy Call (far OTM)", flag: "CE", quantity: 1 },
    ],
    description: "Neutral to slightly bullish — no upside risk",
  },
  {
    id: "custom",
    label: "Custom",
    legs: [{ label: "Leg 1", flag: "CE", quantity: 1 }],
    description: "Build your own multi-leg strategy",
  },
];

// ---------------------------------------------------------------------------
// Leg input state
// ---------------------------------------------------------------------------

interface LegState {
  id: string;
  label: string;
  flag: "CE" | "PE";
  quantity: number;
  strike: number;
  premium: number;
  expiry: string;
}

function makeLegId() {
  return Math.random().toString(36).slice(2, 8);
}

function templateToLegState(t: LegTemplate, atmStrike: number, expiry: string): LegState {
  return {
    id: makeLegId(),
    label: t.label,
    flag: t.flag,
    quantity: t.quantity,
    strike: atmStrike,
    premium: 0,
    expiry,
  };
}

// ---------------------------------------------------------------------------
// Payoff SVG chart
// ---------------------------------------------------------------------------

interface PayoffChartProps {
  data: { spot: number; pnl: number }[];
  breakEvens: number[];
  maxProfit: number;
  maxLoss: number;
}

function PayoffChart({ data, breakEvens, maxProfit, maxLoss }: PayoffChartProps) {
  const W = 600;
  const H = 260;
  const PAD = { top: 20, right: 20, bottom: 40, left: 60 };

  if (data.length === 0) return null;

  const spots = data.map((d) => d.spot);
  const pnls = data.map((d) => d.pnl);

  const minSpot = Math.min(...spots);
  const maxSpot = Math.max(...spots);
  const absMax = Math.max(Math.abs(maxProfit), Math.abs(maxLoss), 1);
  const yMin = -absMax * 1.15;
  const yMax = absMax * 1.15;

  const xScale = (s: number) =>
    PAD.left + ((s - minSpot) / (maxSpot - minSpot)) * (W - PAD.left - PAD.right);
  const yScale = (p: number) =>
    PAD.top + ((yMax - p) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const zeroY = yScale(0);

  // Build polyline points
  const points = data
    .map((d) => `${xScale(d.spot).toFixed(1)},${yScale(d.pnl).toFixed(1)}`)
    .join(" ");

  // Build filled area above/below zero for positive/negative segments
  const positiveSegments: string[] = [];
  const negativeSegments: string[] = [];

  let currentPos: number[][] = [];
  let currentNeg: number[][] = [];

  for (let i = 0; i < data.length; i++) {
    const x = xScale(data[i].spot);
    const y = yScale(data[i].pnl);
    const pnl = data[i].pnl;

    if (pnl >= 0) {
      if (currentNeg.length > 0) {
        // Close negative segment
        currentNeg.push([x, zeroY]);
        negativeSegments.push(currentNeg.map((p) => p.join(",")).join(" "));
        currentNeg = [];
      }
      if (currentPos.length === 0) currentPos.push([x, zeroY]);
      currentPos.push([x, y]);
    } else {
      if (currentPos.length > 0) {
        currentPos.push([x, zeroY]);
        positiveSegments.push(currentPos.map((p) => p.join(",")).join(" "));
        currentPos = [];
      }
      if (currentNeg.length === 0) currentNeg.push([x, zeroY]);
      currentNeg.push([x, y]);
    }
  }
  if (currentPos.length > 0) {
    const lastX = xScale(data[data.length - 1].spot);
    currentPos.push([lastX, zeroY]);
    positiveSegments.push(currentPos.map((p) => p.join(",")).join(" "));
  }
  if (currentNeg.length > 0) {
    const lastX = xScale(data[data.length - 1].spot);
    currentNeg.push([lastX, zeroY]);
    negativeSegments.push(currentNeg.map((p) => p.join(",")).join(" "));
  }

  // Y axis labels
  const yTicks = [yMin * 0.8, yMin * 0.4, 0, yMax * 0.4, yMax * 0.8].map((v) =>
    Math.round(v),
  );

  // X axis ticks — 5 evenly spaced
  const xStep = (maxSpot - minSpot) / 4;
  const xTicks = [0, 1, 2, 3, 4].map((i) => Math.round(minSpot + i * xStep));

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: 320 }}
        aria-label="Payoff diagram at expiry"
        role="img"
      >
        {/* Grid */}
        {yTicks.map((v) => (
          <line
            key={v}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yScale(v)}
            y2={yScale(v)}
            stroke="currentColor"
            strokeOpacity={v === 0 ? 0.3 : 0.1}
            strokeWidth={v === 0 ? 1.5 : 1}
            strokeDasharray={v === 0 ? undefined : "4 3"}
            className="text-[var(--color-fg-muted)]"
          />
        ))}

        {/* Filled positive area */}
        {positiveSegments.map((pts, idx) => (
          <polygon
            key={`pos-${idx}`}
            points={pts}
            fill="color-mix(in oklch, var(--bull) 15%, transparent)"
          />
        ))}

        {/* Filled negative area */}
        {negativeSegments.map((pts, idx) => (
          <polygon
            key={`neg-${idx}`}
            points={pts}
            fill="color-mix(in oklch, var(--bear) 15%, transparent)"
          />
        ))}

        {/* Payoff line */}
        <polyline
          points={points}
          fill="none"
          stroke="hsl(var(--primary, 221 83% 53%))"
          strokeWidth={2}
          strokeLinejoin="round"
          className="text-[var(--color-info)]"
          style={{ stroke: "var(--color-info)" }}
        />

        {/* Break-even vertical lines */}
        {breakEvens.map((be, idx) => (
          <g key={`be-${idx}`}>
            <line
              x1={xScale(be)}
              x2={xScale(be)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="rgb(234 179 8)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
            />
            <text
              x={xScale(be)}
              y={PAD.top - 4}
              textAnchor="middle"
              fontSize={9}
              fill="rgb(234 179 8)"
            >
              BE {be.toFixed(0)}
            </text>
          </g>
        ))}

        {/* Y axis labels */}
        {yTicks.map((v) => (
          <text
            key={v}
            x={PAD.left - 6}
            y={yScale(v) + 4}
            textAnchor="end"
            fontSize={9}
            className="fill-muted-foreground"
            fill="currentColor"
          >
            {v >= 1000 || v <= -1000
              ? `${(v / 1000).toFixed(1)}k`
              : v.toString()}
          </text>
        ))}

        {/* X axis labels */}
        {xTicks.map((v) => (
          <text
            key={v}
            x={xScale(v)}
            y={H - PAD.bottom + 14}
            textAnchor="middle"
            fontSize={9}
            className="fill-muted-foreground"
            fill="currentColor"
          >
            {v.toLocaleString("en-IN")}
          </text>
        ))}

        {/* Axis lines */}
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top}
          y2={H - PAD.bottom}
          stroke="currentColor"
          strokeOpacity={0.3}
          className="text-border"
        />
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="currentColor"
          strokeOpacity={0.3}
          className="text-border"
        />

        {/* Axis label */}
        <text
          x={W / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          className="fill-muted-foreground"
        >
          Spot at Expiry
        </text>
        <text
          x={10}
          y={H / 2}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          className="fill-muted-foreground"
          transform={`rotate(-90, 10, ${H / 2})`}
        >
          P&amp;L (₹)
        </text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function OptionsWorkbenchPage() {
  // Strategy selection
  const [strategyId, setStrategyId] = React.useState<StrategyId>("long_call");

  // Symbol for chain fetch
  const [symbol, setSymbol] = React.useState("NIFTY");
  const [symbolInput, setSymbolInput] = React.useState("NIFTY");

  // Option chain data
  const [chain, setChain] = React.useState<OptionChain | null>(null);
  const [chainLoading, setChainLoading] = React.useState(false);
  const [chainError, setChainError] = React.useState<string | null>(null);

  // Derived ATM strike
  const atmStrike = React.useMemo(() => {
    if (!chain?.spot) return 0;
    // Find the closest strike to spot
    const strikes = chain.rows.map((r) => r.strike);
    if (strikes.length === 0) return Math.round(chain.spot / 50) * 50;
    return strikes.reduce((prev, curr) =>
      Math.abs(curr - chain.spot!) < Math.abs(prev - chain.spot!) ? curr : prev,
    );
  }, [chain]);

  // Leg state
  const [legs, setLegs] = React.useState<LegState[]>([]);

  // Computed results
  const [result, setResult] = React.useState<ReturnType<typeof computePayoff> | null>(null);
  const [netGreeks, setNetGreeks] = React.useState<{
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  } | null>(null);

  // ----- Fetch option chain -----
  const fetchChain = React.useCallback(async (sym: string) => {
    setChainLoading(true);
    setChainError(null);
    try {
      const res = await fetch(`/api/in/option-chain?symbol=${encodeURIComponent(sym)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OptionChain;
      setChain(data);
    } catch (e) {
      setChainError((e as Error).message ?? "Failed to fetch chain");
    } finally {
      setChainLoading(false);
    }
  }, []);

  // Fetch chain on mount
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchChain(symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Populate legs when strategy or ATM changes -----
  React.useEffect(() => {
    const def = STRATEGIES.find((s) => s.id === strategyId);
    if (!def || atmStrike === 0) return;

    const expiry = chain?.expiry ?? "";

    // For spread strategies, offset strikes by one step
    const strikeStep = symbol.includes("NIFTY") && !symbol.includes("BANK") ? 50 : 100;
    const strikeStepBank = symbol.includes("BANKNIFTY") ? 100 : strikeStep;
    const step = strikeStepBank;

    const newLegs: LegState[] = def.legs.map((t, idx) => {
      let strike = atmStrike;
      // Assign sensible strike offsets by position in the strategy
      if (def.id === "bull_call_spread") {
        strike = idx === 0 ? atmStrike : atmStrike + step;
      } else if (def.id === "bear_put_spread") {
        strike = idx === 0 ? atmStrike : atmStrike - step;
      } else if (def.id === "bear_call_spread") {
        strike = idx === 0 ? atmStrike : atmStrike + step;
      } else if (def.id === "iron_condor") {
        const offsets = [-2 * step, -step, step, 2 * step];
        strike = atmStrike + offsets[idx];
      } else if (def.id === "strangle") {
        strike = idx === 0 ? atmStrike + step : atmStrike - step;
      } else if (def.id === "butterfly") {
        const offsets = [-step, 0, step];
        strike = atmStrike + offsets[idx];
      } else if (def.id === "jade_lizard") {
        const offsets = [-step, step, 2 * step];
        strike = atmStrike + offsets[idx];
      }

      // Try to prefill premium from chain
      let premium = 0;
      if (chain) {
        const row = chain.rows.find((r) => r.strike === strike);
        if (row) {
          premium = (t.flag === "CE" ? row.ce?.ltp : row.pe?.ltp) ?? 0;
        }
      }

      return {
        id: makeLegId(),
        label: t.label,
        flag: t.flag,
        quantity: t.quantity,
        strike,
        premium,
        expiry,
      };
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLegs(newLegs);
    setResult(null);
    setNetGreeks(null);
  }, [strategyId, atmStrike, chain, symbol]);

  // ----- Update a single leg field -----
  const updateLeg = (id: string, field: keyof LegState, value: string | number) => {
    setLegs((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, [field]: value } : l,
      ),
    );
  };

  // ----- Add / remove legs (for custom strategy) -----
  const addLeg = () => {
    setLegs((prev) => [
      ...prev,
      {
        id: makeLegId(),
        label: `Leg ${prev.length + 1}`,
        flag: "CE",
        quantity: 1,
        strike: atmStrike || 0,
        premium: 0,
        expiry: chain?.expiry ?? "",
      },
    ]);
  };

  const removeLeg = (id: string) => {
    setLegs((prev) => prev.filter((l) => l.id !== id));
  };

  // ----- Calculate payoff -----
  const calculate = () => {
    if (legs.length === 0) return;

    const spot = chain?.spot ?? atmStrike;
    if (!spot) return;

    // Build spot range: ±20% from current spot in 100 steps
    const lo = spot * 0.8;
    const hi = spot * 1.2;
    const steps = 100;
    const spotRange = Array.from({ length: steps + 1 }, (_, i) =>
      lo + (i / steps) * (hi - lo),
    );

    const optionLegs: OptionLeg[] = legs.map((l) => ({
      strike: l.strike,
      flag: l.flag,
      quantity: l.quantity,
      premium: l.premium,
      expiry: l.expiry,
    }));

    const premiums = legs.map((l) => l.premium);

    const analysis = computePayoff(optionLegs, spotRange, premiums);
    setResult(analysis);

    // Build net greeks from chain data where available
    const greeksPerLeg: Greeks[] = legs.map((l) => {
      if (!chain) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const row = chain.rows.find((r) => r.strike === l.strike);
      const side = l.flag === "CE" ? row?.ce : row?.pe;
      return {
        delta: side?.delta ?? 0,
        gamma: side?.gamma ?? 0,
        theta: side?.theta ?? 0,
        vega: side?.vega ?? 0,
      };
    });

    const ng = aggregateGreeks(optionLegs, greeksPerLeg);
    setNetGreeks(ng);
  };

  // ----- Scan for best strikes -----
  const [scanning, setScanning] = React.useState(false);
  const [scanMessage, setScanMessage] = React.useState<string | null>(null);

  const scanBestStrikes = async () => {
    if (!chain) return;
    setScanning(true);
    setScanMessage(null);

    try {
      // Fetch GEX to get expected move band
      const gexRes = await fetch(`/api/in/gex?symbol=${encodeURIComponent(symbol)}`);
      let expectedMove = 0.02; // default 2%

      if (gexRes.ok) {
        const gexData = (await gexRes.json()) as {
          available: boolean;
          expectedMovePct?: number;
        };
        if (gexData.available && gexData.expectedMovePct) {
          expectedMove = gexData.expectedMovePct / 100;
        }
      }

      const spot = chain.spot ?? atmStrike;
      const loBand = spot * (1 - expectedMove);
      const hiBand = spot * (1 + expectedMove);

      // Find strikes bracketing the expected move band
      const rows = chain.rows.filter(
        (r) => r.strike >= loBand * 0.95 && r.strike <= hiBand * 1.05,
      );

      if (rows.length < 2) {
        setScanMessage("Not enough strikes in the expected move band.");
        return;
      }

      const def = STRATEGIES.find((s) => s.id === strategyId);
      if (!def) return;

      // For iron condor: suggest short strikes near band edges, longs outside
      if (strategyId === "iron_condor" && rows.length >= 4) {
        const sorted = rows.map((r) => r.strike).sort((a, b) => a - b);
        const shortPut = sorted[Math.floor(sorted.length * 0.25)];
        const shortCall = sorted[Math.floor(sorted.length * 0.75)];
        const step = (shortCall - shortPut) / 2;
        const longPut = shortPut - step;
        const longCall = shortCall + step;

        setLegs((prev) =>
          prev.map((l, idx) => {
            const newStrikes = [longPut, shortPut, shortCall, longCall];
            const strike = newStrikes[idx] ?? l.strike;
            const row = chain.rows.find((r) => r.strike === strike);
            const premium = (l.flag === "CE" ? row?.ce?.ltp : row?.pe?.ltp) ?? l.premium;
            return { ...l, strike, premium };
          }),
        );

        setScanMessage(
          `Suggested Iron Condor strikes: ${longPut}/${shortPut}/${shortCall}/${longCall} (±${(expectedMove * 100).toFixed(1)}% move)`,
        );
      } else {
        // Generic: place legs at equidistant strikes within band
        const sorted = rows.map((r) => r.strike).sort((a, b) => a - b);
        const step = Math.floor(sorted.length / (def.legs.length + 1));

        setLegs((prev) =>
          prev.map((l, idx) => {
            const strikeIdx = Math.min(step * (idx + 1), sorted.length - 1);
            const strike = sorted[strikeIdx] ?? l.strike;
            const row = chain.rows.find((r) => r.strike === strike);
            const premium = (l.flag === "CE" ? row?.ce?.ltp : row?.pe?.ltp) ?? l.premium;
            return { ...l, strike, premium };
          }),
        );

        setScanMessage(
          `Strikes updated to span ±${(expectedMove * 100).toFixed(1)}% GEX-implied expected move.`,
        );
      }
    } catch {
      setScanMessage("Failed to fetch GEX data. Using current strikes.");
    } finally {
      setScanning(false);
    }
  };

  const selectedStrategy = STRATEGIES.find((s) => s.id === strategyId)!;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-end justify-between gap-3"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/20 to-blue-500/20 shrink-0">
            <TrendingUp className="h-5 w-5 text-[var(--color-brand)]" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Options Workbench
            </h1>
            <p className="text-xs sm:text-sm text-[var(--color-fg-muted)]">
              Multi-leg strategy builder — payoff diagram, greeks & break-evens
            </p>
          </div>
        </div>

        {/* Symbol input */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = symbolInput.trim().toUpperCase();
            if (!v) return;
            setSymbol(v);
            fetchChain(v);
          }}
          className="flex gap-2"
        >
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            placeholder="Symbol (e.g. NIFTY)"
            className="text-sm px-3 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] outline-none focus:border-[var(--color-brand)] transition-colors w-40"
          />
          <Button type="submit" size="sm" disabled={chainLoading}>
            {chainLoading ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "Load"
            )}
          </Button>
        </form>
      </motion.div>

      {/* ── Chain error ── */}
      {chainError && (
        <div className="rounded-xl border border-[color-mix(in_oklch,var(--bear)_30%,transparent)] bg-[color-mix(in_oklch,var(--bear)_5%,transparent)] p-3 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-[var(--color-bear)] mt-0.5 shrink-0" />
          <div className="text-sm text-[var(--color-bear)] flex-1">
            <span className="font-medium">Could not load option chain</span>
            <span className="ml-2 text-xs text-[var(--color-bear)]/70">{chainError}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fetchChain(symbol)}
            className="shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      )}

      {/* ── Chain info badge ── */}
      {chain && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--color-fg-muted)]">
          <span>
            <span className="font-medium text-[var(--color-fg)]">{chain.symbol}</span>{" "}
            spot{" "}
            <span className="font-medium text-[var(--color-fg)]">
              {chain.spot?.toLocaleString("en-IN") ?? "—"}
            </span>
          </span>
          <span>
            Expiry{" "}
            <span className="font-medium text-[var(--color-fg)]">{chain.expiry}</span>
          </span>
          <span>
            ATM Strike{" "}
            <span className="font-medium text-[var(--color-brand)]">
              {atmStrike || "—"}
            </span>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_420px] gap-6">
        {/* ── Left column: strategy picker + leg inputs ── */}
        <div className="space-y-5">
          {/* Strategy picker */}
          <div className="glass rounded-2xl p-4 space-y-3">
            <h2 className="text-sm font-semibold">Strategy</h2>
            <div className="flex flex-wrap gap-2">
              {STRATEGIES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStrategyId(s.id)}
                  className={`text-xs px-2.5 py-1.5 rounded-md font-medium transition-colors ${
                    strategyId === s.id
                      ? "bg-violet-500 text-white"
                      : "bg-muted text-[var(--color-fg-muted)] hover:bg-muted/70"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {selectedStrategy.description}
            </p>
          </div>

          {/* Leg inputs */}
          <div className="glass rounded-2xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Legs</h2>
              {strategyId === "custom" && (
                <Button size="xs" variant="outline" onClick={addLeg}>
                  + Add Leg
                </Button>
              )}
            </div>

            {legs.length === 0 && (
              <p className="text-xs text-[var(--color-fg-muted)] py-2">
                Select a strategy to populate legs.
              </p>
            )}

            <div className="space-y-3">
              {legs.map((leg, idx) => (
                <div
                  key={leg.id}
                  className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_auto] gap-2 items-center"
                >
                  {/* Direction badge */}
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      leg.quantity > 0
                        ? "bg-[color-mix(in_oklch,var(--bull)_18%,transparent)] text-[var(--color-bull)]"
                        : "bg-[color-mix(in_oklch,var(--bear)_18%,transparent)] text-[var(--color-bear)]"
                    }`}
                  >
                    {leg.quantity > 0 ? "BUY" : "SELL"}
                  </span>

                  {/* Flag */}
                  <select
                    value={leg.flag}
                    onChange={(e) =>
                      updateLeg(leg.id, "flag", e.target.value as "CE" | "PE")
                    }
                    className="text-xs px-2 py-1 rounded bg-muted border border-[var(--color-border)] outline-none"
                    aria-label={`Leg ${idx + 1} option type`}
                  >
                    <option value="CE">CE</option>
                    <option value="PE">PE</option>
                  </select>

                  {/* Strike */}
                  <div className="flex flex-col">
                    <label className="text-[9px] text-[var(--color-fg-muted)] mb-0.5">
                      Strike
                    </label>
                    <input
                      type="number"
                      value={leg.strike}
                      onChange={(e) =>
                        updateLeg(leg.id, "strike", parseFloat(e.target.value) || 0)
                      }
                      className="text-xs px-2 py-1 rounded bg-muted border border-[var(--color-border)] outline-none w-full"
                      aria-label={`Leg ${idx + 1} strike`}
                    />
                  </div>

                  {/* Premium */}
                  <div className="flex flex-col">
                    <label className="text-[9px] text-[var(--color-fg-muted)] mb-0.5">
                      Premium
                    </label>
                    <input
                      type="number"
                      value={leg.premium}
                      onChange={(e) =>
                        updateLeg(leg.id, "premium", parseFloat(e.target.value) || 0)
                      }
                      className="text-xs px-2 py-1 rounded bg-muted border border-[var(--color-border)] outline-none w-full"
                      step="0.05"
                      min="0"
                      aria-label={`Leg ${idx + 1} premium`}
                    />
                  </div>

                  {/* Qty */}
                  <div className="flex flex-col">
                    <label className="text-[9px] text-[var(--color-fg-muted)] mb-0.5">
                      Qty
                    </label>
                    <input
                      type="number"
                      value={leg.quantity}
                      onChange={(e) =>
                        updateLeg(leg.id, "quantity", parseInt(e.target.value, 10) || 1)
                      }
                      className="text-xs px-2 py-1 rounded bg-muted border border-[var(--color-border)] outline-none w-full"
                      aria-label={`Leg ${idx + 1} quantity`}
                    />
                  </div>

                  {/* Remove (custom only) */}
                  {strategyId === "custom" ? (
                    <button
                      onClick={() => removeLeg(leg.id)}
                      className="text-[var(--color-fg-muted)] hover:text-[var(--color-bear)] transition-colors text-xs px-1"
                      aria-label={`Remove leg ${idx + 1}`}
                    >
                      ✕
                    </button>
                  ) : (
                    <span className="w-5" />
                  )}
                </div>
              ))}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                onClick={calculate}
                disabled={legs.length === 0 || (!chain?.spot && atmStrike === 0)}
              >
                <Calculator className="h-4 w-4 mr-1.5" />
                Calculate
              </Button>
              <Button
                variant="outline"
                onClick={scanBestStrikes}
                disabled={scanning || !chain}
              >
                {scanning ? (
                  <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <Search className="h-4 w-4 mr-1.5" />
                )}
                Scan for Best Strikes
              </Button>
            </div>

            {scanMessage && (
              <p className="text-xs text-[var(--color-fg-muted)] bg-[var(--color-surface)]/50 rounded px-3 py-2">
                {scanMessage}
              </p>
            )}
          </div>
        </div>

        {/* ── Right column: results ── */}
        <div className="space-y-5">
          {/* Payoff diagram */}
          {result ? (
            <div className="glass rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Payoff at Expiry</h2>
                <div className="flex gap-4 text-xs">
                  <span className="text-[var(--color-bull)]">
                    Max profit:{" "}
                    {result.maxProfit === Infinity
                      ? "Unlimited"
                      : `₹${result.maxProfit.toFixed(0)}`}
                  </span>
                  <span className="text-[var(--color-bear)]">
                    Max loss:{" "}
                    {result.maxLoss === -Infinity
                      ? "Unlimited"
                      : `₹${result.maxLoss.toFixed(0)}`}
                  </span>
                </div>
              </div>

              <PayoffChart
                data={result.payoffAtExpiry}
                breakEvens={result.breakEvens}
                maxProfit={result.maxProfit}
                maxLoss={result.maxLoss}
              />
            </div>
          ) : (
            <div className="glass rounded-2xl p-8 text-center text-sm text-[var(--color-fg-muted)]">
              Enter leg details and click <strong>Calculate</strong> to see the
              payoff diagram.
            </div>
          )}

          {/* Break-evens */}
          {result && result.breakEvens.length > 0 && (
            <div className="glass rounded-2xl p-4 space-y-2">
              <h2 className="text-sm font-semibold">Break-even Points</h2>
              <div className="flex flex-wrap gap-3">
                {result.breakEvens.map((be, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] border border-[color-mix(in_oklch,var(--warning)_30%,transparent)] rounded-lg px-3 py-2"
                  >
                    <div className="w-2 h-2 rounded-full bg-yellow-500 shrink-0" />
                    <span className="text-sm font-medium">
                      {be.toLocaleString("en-IN", {
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                ))}
              </div>
              {chain?.spot && (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  Spot is currently{" "}
                  <span className="font-medium">
                    {chain.spot.toLocaleString("en-IN")}
                  </span>
                  {result.breakEvens.length === 2 && (
                    <>
                      {" "}
                      — profit zone:{" "}
                      <span className="text-[var(--color-bull)] font-medium">
                        below {result.breakEvens[0].toFixed(0)} or above{" "}
                        {result.breakEvens[1].toFixed(0)}
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {result && result.breakEvens.length === 0 && (
            <div className="glass rounded-2xl p-4 space-y-2">
              <h2 className="text-sm font-semibold">Break-even Points</h2>
              <p className="text-xs text-[var(--color-fg-muted)]">
                No break-even in the current spot range (±20%). The strategy
                may be entirely profitable or entirely losing at expiry within
                this range.
              </p>
            </div>
          )}

          {/* Net greeks */}
          {netGreeks && (
            <div className="glass rounded-2xl p-4 space-y-3">
              <h2 className="text-sm font-semibold">Net Greeks</h2>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    {
                      label: "Delta (Δ)",
                      value: netGreeks.delta,
                      hint: "Price sensitivity to ±1pt move",
                    },
                    {
                      label: "Gamma (Γ)",
                      value: netGreeks.gamma,
                      hint: "Delta change per ±1pt move",
                    },
                    {
                      label: "Theta (Θ)",
                      value: netGreeks.theta,
                      hint: "Time decay per day",
                    },
                    {
                      label: "Vega (ν)",
                      value: netGreeks.vega,
                      hint: "Sensitivity to ±1% IV move",
                    },
                  ] as const
                ).map(({ label, value, hint }) => (
                  <div
                    key={label}
                    className="bg-[var(--color-surface)]/40 rounded-lg p-3 space-y-1"
                  >
                    <div className="text-[10px] text-[var(--color-fg-muted)] uppercase tracking-wide">
                      {label}
                    </div>
                    <div
                      className={`text-lg font-semibold tabular-nums ${
                        value > 0
                          ? "text-[var(--color-bull)]"
                          : value < 0
                            ? "text-[var(--color-bear)]"
                            : "text-[var(--color-fg)]"
                      }`}
                    >
                      {value.toFixed(4)}
                    </div>
                    <div className="text-[9px] text-[var(--color-fg-muted)]">{hint}</div>
                  </div>
                ))}
              </div>

              {Math.abs(netGreeks.delta) < 0.05 && (
                <p className="text-xs text-[var(--color-bull)]/80">
                  ✓ Near delta-neutral (Δ ≈ 0)
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
