"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useGex } from "@/hooks/india/use-gex";
import type { GexResult } from "@/app/api/in/gex/route";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GexPanelProps {
  symbol?: string;
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStrike(value: number): string {
  return value.toLocaleString("en-IN");
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
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
// GexBarChart — SVG bar chart of per-strike GEX values
// ---------------------------------------------------------------------------

interface GexBarChartProps {
  strikes: number[];
  gexPerStrike: number[];
  gammaFlip: number;
  spot: number;
}

function GexBarChart({
  strikes,
  gexPerStrike,
  gammaFlip,
  spot,
}: GexBarChartProps) {
  const width = 320;
  const height = 120;
  const paddingX = 4;
  const paddingY = 8;
  const chartWidth = width - paddingX * 2;
  const chartHeight = height - paddingY * 2;

  if (!strikes.length || !gexPerStrike.length) return null;

  const maxAbs = Math.max(...gexPerStrike.map(Math.abs), 1);
  const barWidth = Math.max(1, (chartWidth / strikes.length) - 1);
  const midY = paddingY + chartHeight / 2;

  return (
    <svg
      data-testid="gex-chart"
      aria-label="GEX per strike bar chart"
      role="img"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      className="w-full overflow-visible"
    >
      {/* Zero axis */}
      <line
        x1={paddingX}
        y1={midY}
        x2={width - paddingX}
        y2={midY}
        stroke="var(--color-border)"
        strokeWidth="0.5"
      />

      {/* Gamma flip marker */}
      {strikes.includes(gammaFlip) && (() => {
        const flipIdx = strikes.indexOf(gammaFlip);
        const flipX =
          paddingX + flipIdx * (barWidth + 1) + barWidth / 2;
        return (
          <line
            x1={flipX}
            y1={paddingY}
            x2={flipX}
            y2={paddingY + chartHeight}
            stroke="var(--color-warning, #f59e0b)"
            strokeWidth="1"
            strokeDasharray="3 2"
            opacity={0.8}
          />
        );
      })()}

      {/* Bars */}
      {strikes.map((strike, i) => {
        const gex = gexPerStrike[i] ?? 0;
        const barHeight = (Math.abs(gex) / maxAbs) * (chartHeight / 2);
        const barX = paddingX + i * (barWidth + 1);
        const barY = gex >= 0 ? midY - barHeight : midY;
        const color =
          gex >= 0
            ? "var(--color-bull, #22c55e)"
            : "var(--color-bear, #ef4444)";
        const isNearSpot = Math.abs(strike - spot) / spot < 0.02;

        return (
          <rect
            key={strike}
            x={barX}
            y={barY}
            width={barWidth}
            height={Math.max(barHeight, 1)}
            fill={color}
            opacity={isNearSpot ? 1 : 0.75}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * GexPanel — displays Dealer Gamma Exposure (GEX) analytics.
 *
 * Shows a per-strike GEX bar chart (green = positive/stabilising,
 * red = negative/destabilising), the Gamma Flip strike level, and the
 * expected daily move percentage.
 *
 * Degrades gracefully: shows UnavailableBadge when available === false,
 * and a loading skeleton while data is in-flight.
 *
 * Validates: Requirements 4.6, 4.7, 13.4
 */
export function GexPanel({
  symbol = "NIFTY",
  intervalMs,
}: GexPanelProps) {
  const { data, isLoading } = useGex(symbol, intervalMs);

  // Loading state
  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GEX — Dealer Gamma Exposure</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            data-testid="skeleton"
            role="status"
            aria-label="Loading GEX data"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-[120px] w-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
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
          <CardTitle>GEX — Dealer Gamma Exposure</CardTitle>
        </CardHeader>
        <CardContent>
          <UnavailableBadge reason={(data as Partial<GexResult> | null)?.reason} />
        </CardContent>
      </Card>
    );
  }

  // Available state
  const {
    strikes,
    gexPerStrike,
    gammaFlip,
    expectedMovePct,
    spot,
    aggregateGex,
  } = data;

  const gexSign = aggregateGex >= 0 ? "+" : "";
  const flipFormatted = formatStrike(gammaFlip);
  const expectedMoveFormatted = formatPct(expectedMovePct);
  const isPositiveGex = aggregateGex >= 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>GEX — Dealer Gamma Exposure</CardTitle>
          <Badge variant={isPositiveGex ? "bull" : "bear"}>
            {gexSign}
            {(aggregateGex / 1e9).toFixed(1)}B
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {/* Bar chart */}
          <GexBarChart
            strikes={strikes}
            gexPerStrike={gexPerStrike}
            gammaFlip={gammaFlip}
            spot={spot}
          />

          {/* Gamma flip + expected move row */}
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="flex flex-col gap-0.5">
              <span
                data-testid="gamma-flip-label"
                className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]"
              >
                Gamma Flip
              </span>
              <span className="tabular-nums font-semibold text-[var(--color-warning,#f59e0b)]">
                {flipFormatted}
              </span>
            </div>

            <div className="flex flex-col gap-0.5 text-right">
              <span
                data-testid="expected-move"
                className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]"
              >
                Expected Move
              </span>
              <span className="tabular-nums font-semibold">
                ±{expectedMoveFormatted}
              </span>
            </div>
          </div>

          {/* Symbol */}
          <div className="text-[11px] text-[var(--color-fg-subtle)]">
            {symbol} · Spot {formatStrike(spot)}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
