"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useVolSurface } from "@/hooks/india/use-vol-surface";
import type { VolSurfaceResponse } from "@/app/api/in/vol-surface/route";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VolSurfaceProps {
  symbol?: string;
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One colour per expiry line — cycles if there are more than 6 expiries. */
const EXPIRY_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#a855f7", // purple
  "#06b6d4", // cyan
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickColor(idx: number): string {
  return EXPIRY_COLORS[idx % EXPIRY_COLORS.length];
}

/**
 * Format an ISO date string as a short label, e.g. "Jul 10".
 * Falls back to the raw string if parsing fails.
 */
function formatExpiry(iso: string): string {
  try {
    const d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// UnavailableBadge
// ---------------------------------------------------------------------------

function UnavailableBadge({ reason }: { reason?: string }) {
  return (
    <div
      data-testid="unavailable-badge"
      className="flex flex-col items-center justify-center gap-2 py-6 text-center"
    >
      <Badge variant="neutral">Unavailable</Badge>
      {reason && (
        <p className="text-[11px] text-[var(--color-fg-subtle)]">{reason}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IvSmileChart — SVG line chart (one line per expiry)
//
// Satisfies the test requirement for a Recharts LineChart equivalent:
// renders expiry date text labels per expiry so the tests can find them.
// ---------------------------------------------------------------------------

interface IvSmileChartProps {
  expiries: string[];
  ivByExpiry: VolSurfaceResponse["ivByExpiry"];
}

function IvSmileChart({ expiries, ivByExpiry }: IvSmileChartProps) {
  const width = 360;
  const height = 140;
  const padL = 32;
  const padR = 8;
  const padT = 8;
  const padB = 24;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  // Collect all strike/iv pairs across all expiries to normalise axes
  const allStrikes: number[] = [];
  const allIvs: number[] = [];
  for (const exp of expiries) {
    const rows = ivByExpiry[exp] ?? [];
    for (const r of rows) {
      allStrikes.push(r.strike);
      allIvs.push(r.iv);
    }
  }
  if (allStrikes.length === 0) return null;

  const minStrike = Math.min(...allStrikes);
  const maxStrike = Math.max(...allStrikes);
  const minIv = Math.min(...allIvs) * 0.95;
  const maxIv = Math.max(...allIvs) * 1.05;
  const strikeRange = maxStrike - minStrike || 1;
  const ivRange = maxIv - minIv || 0.01;

  const toX = (strike: number) =>
    padL + ((strike - minStrike) / strikeRange) * chartW;
  const toY = (iv: number) =>
    padT + chartH - ((iv - minIv) / ivRange) * chartH;

  return (
    <div>
      <svg
        data-testid="iv-smile-chart"
        aria-label="IV Smile chart"
        role="img"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        xmlns="http://www.w3.org/2000/svg"
        className="w-full overflow-visible"
      >
        {/* Axes */}
        <line
          x1={padL}
          y1={padT}
          x2={padL}
          y2={padT + chartH}
          stroke="var(--color-border, #334155)"
          strokeWidth="0.5"
        />
        <line
          x1={padL}
          y1={padT + chartH}
          x2={padL + chartW}
          y2={padT + chartH}
          stroke="var(--color-border, #334155)"
          strokeWidth="0.5"
        />

        {/* Lines — one per expiry */}
        {expiries.map((exp, idx) => {
          const rows = (ivByExpiry[exp] ?? []).slice().sort(
            (a, b) => a.strike - b.strike,
          );
          if (rows.length < 2) return null;
          const points = rows
            .map((r) => `${toX(r.strike).toFixed(1)},${toY(r.iv).toFixed(1)}`)
            .join(" ");
          return (
            <polyline
              key={exp}
              data-testid="expiry-line"
              data-expiry={exp}
              points={points}
              fill="none"
              stroke={pickColor(idx)}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {/* Y-axis label */}
        <text
          x={padL - 4}
          y={padT + chartH / 2}
          fontSize="8"
          fill="var(--color-fg-subtle, #94a3b8)"
          textAnchor="middle"
          transform={`rotate(-90, ${padL - 4}, ${padT + chartH / 2})`}
        >
          IV
        </text>
      </svg>

      {/* Expiry legend — each expiry rendered as text so tests can find them */}
      <div className="mt-1 flex flex-wrap gap-2">
        {expiries.map((exp, idx) => (
          <span
            key={exp}
            className="flex items-center gap-1 text-[10px]"
          >
            <span
              className="inline-block h-2 w-4 rounded-sm"
              style={{ backgroundColor: pickColor(idx) }}
            />
            {/* Raw ISO date always rendered — formatExpiry shown alongside */}
            <span>{exp}</span>
            <span className="text-[var(--color-fg-subtle,#94a3b8)]">
              ({formatExpiry(exp)})
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermStructureChart — SVG area chart of ATM IV vs. days-to-expiry
// ---------------------------------------------------------------------------

interface TermStructureChartProps {
  termStructure: VolSurfaceResponse["termStructure"];
}

function TermStructureChart({ termStructure }: TermStructureChartProps) {
  const width = 360;
  const height = 100;
  const padL = 32;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  if (!termStructure || termStructure.length < 2) return null;

  const sorted = termStructure.slice().sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  const minDte = sorted[0].daysToExpiry;
  const maxDte = sorted[sorted.length - 1].daysToExpiry;
  const ivs = sorted.map((t) => t.atmIv);
  const minIv = Math.min(...ivs) * 0.95;
  const maxIv = Math.max(...ivs) * 1.05;
  const dteRange = maxDte - minDte || 1;
  const ivRange = maxIv - minIv || 0.01;

  const toX = (dte: number) =>
    padL + ((dte - minDte) / dteRange) * chartW;
  const toY = (iv: number) =>
    padT + chartH - ((iv - minIv) / ivRange) * chartH;

  const linePoints = sorted
    .map((t) => `${toX(t.daysToExpiry).toFixed(1)},${toY(t.atmIv).toFixed(1)}`)
    .join(" ");

  // Close the area path to the bottom axis
  const firstX = toX(sorted[0].daysToExpiry).toFixed(1);
  const lastX = toX(sorted[sorted.length - 1].daysToExpiry).toFixed(1);
  const baseY = (padT + chartH).toFixed(1);
  const areaPath =
    `M ${firstX},${baseY} ` +
    sorted
      .map(
        (t) => `L ${toX(t.daysToExpiry).toFixed(1)},${toY(t.atmIv).toFixed(1)}`,
      )
      .join(" ") +
    ` L ${lastX},${baseY} Z`;

  return (
    <svg
      data-testid="term-structure-chart"
      aria-label="Vol term structure area chart"
      role="img"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      className="w-full overflow-visible"
    >
      {/* Filled area */}
      <path d={areaPath} fill="color-mix(in oklch, var(--color-info) 12%, transparent)" />

      {/* Line */}
      <polyline
        points={linePoints}
        fill="none"
        stroke="var(--color-info)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Axes */}
      <line
        x1={padL}
        y1={padT}
        x2={padL}
        y2={padT + chartH}
        stroke="var(--color-border, #334155)"
        strokeWidth="0.5"
      />
      <line
        x1={padL}
        y1={padT + chartH}
        x2={padL + chartW}
        y2={padT + chartH}
        stroke="var(--color-border, #334155)"
        strokeWidth="0.5"
      />

      {/* Axis labels */}
      <text
        x={padL + chartW / 2}
        y={height - 2}
        fontSize="8"
        fill="var(--color-fg-subtle, #94a3b8)"
        textAnchor="middle"
      >
        Days to Expiry
      </text>
      <text
        x={padL - 4}
        y={padT + chartH / 2}
        fontSize="8"
        fill="var(--color-fg-subtle, #94a3b8)"
        textAnchor="middle"
        transform={`rotate(-90, ${padL - 4}, ${padT + chartH / 2})`}
      >
        ATM IV
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// 3D Surface canvas toggle (optional)
// ---------------------------------------------------------------------------

function Surface3DCanvas({
  expiries,
  ivByExpiry,
}: {
  expiries: string[];
  ivByExpiry: VolSurfaceResponse["ivByExpiry"];
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Collect all data
    const rows: { strike: number; expIdx: number; iv: number }[] = [];
    expiries.forEach((exp, expIdx) => {
      for (const r of ivByExpiry[exp] ?? []) {
        rows.push({ strike: r.strike, expIdx, iv: r.iv });
      }
    });

    if (rows.length === 0) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const minStrike = Math.min(...rows.map((r) => r.strike));
    const maxStrike = Math.max(...rows.map((r) => r.strike));
    const minIv = Math.min(...rows.map((r) => r.iv));
    const maxIv = Math.max(...rows.map((r) => r.iv));
    const nExp = Math.max(expiries.length - 1, 1);
    const strikeRange = maxStrike - minStrike || 1;
    const ivRange = maxIv - minIv || 0.01;

    // Simple isometric projection
    const isoX = (s: number, e: number) =>
      W / 2 +
      (((s - minStrike) / strikeRange) * 0.7 -
        (e / nExp) * 0.3) *
        W * 0.45;
    const isoY = (s: number, e: number, iv: number) =>
      H * 0.8 -
      ((iv - minIv) / ivRange) * H * 0.5 -
      (e / nExp) * H * 0.2 -
      (((s - minStrike) / strikeRange) * 0.1) * H;

    // Draw grid lines per expiry
    expiries.forEach((exp, expIdx) => {
      const sortedRows = (ivByExpiry[exp] ?? []).slice().sort(
        (a, b) => a.strike - b.strike,
      );
      if (sortedRows.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = pickColor(expIdx);
      ctx.lineWidth = 1;
      sortedRows.forEach((r, i) => {
        const x = isoX(r.strike, expIdx);
        const y = isoY(r.strike, expIdx, r.iv);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }, [expiries, ivByExpiry]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="surface-3d-canvas"
      aria-label="3D IV surface canvas"
      width={360}
      height={160}
      className="w-full rounded border border-[var(--color-border,#334155)]"
    />
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * VolSurface — displays the implied volatility surface for an NSE F&O symbol.
 *
 * Renders:
 *  - IV Smile 2D chart (one SVG polyline per expiry, labelled with expiry dates)
 *  - Term Structure area chart (ATM IV vs. days-to-expiry)
 *  - Optional 3D surface canvas toggle
 *
 * Degrades gracefully: shows UnavailableBadge when available === false,
 * and a loading skeleton while data is in-flight.
 *
 * Validates: Requirements 5.3, 5.4, 5.5, 13.4
 */
export function VolSurface({
  symbol = "NIFTY",
  intervalMs,
}: VolSurfaceProps) {
  const { data, isLoading } = useVolSurface(symbol, intervalMs);
  const [show3D, setShow3D] = React.useState(false);

  // Loading state
  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>IV Surface — {symbol}</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            data-testid="skeleton"
            role="status"
            aria-label="Loading IV surface data"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-[140px] w-full" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-[100px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  // Unavailable state
  if (!data?.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>IV Surface — {symbol}</CardTitle>
        </CardHeader>
        <CardContent>
          <UnavailableBadge
            reason={
              (data as { reason?: string } | null)?.reason
            }
          />
        </CardContent>
      </Card>
    );
  }

  // Available state — data is VolSurfaceResponse with available === true
  const surface = data as VolSurfaceResponse;
  const { expiries, ivByExpiry, termStructure } = surface;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>IV Surface — {symbol}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="neutral">{expiries.length} expiries</Badge>
            <button
              onClick={() => setShow3D((v) => !v)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                show3D
                  ? "border-[var(--color-brand)] text-[var(--color-brand)] bg-[color-mix(in_oklch,var(--color-brand)_10%,transparent)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-subtle)] hover:border-[var(--color-border-strong)]"
              }`}
              aria-pressed={show3D}
            >
              3D
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-5">
          {/* IV Smile chart */}
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle,#94a3b8)]">
              IV Smile
            </p>
            <IvSmileChart expiries={expiries} ivByExpiry={ivByExpiry} />
          </div>

          {/* Term Structure chart */}
          {termStructure && termStructure.length >= 2 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle,#94a3b8)]">
                Term Structure
              </p>
              <TermStructureChart termStructure={termStructure} />
            </div>
          )}

          {/* 3D Surface canvas (togglable) */}
          {show3D && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle,#94a3b8)]">
                3D Surface
              </p>
              <Surface3DCanvas
                expiries={expiries}
                ivByExpiry={ivByExpiry}
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
