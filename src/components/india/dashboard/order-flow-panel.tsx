"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrderFlow } from "@/hooks/india/use-order-flow";
import type { VpinResponse } from "@/app/api/in/order-flow/route";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrderFlowPanelProps {
  symbol?: string;
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function classify(vpin: number): VpinResponse["classification"] {
  if (vpin >= 0.7) return "toxic";
  if (vpin <= 0.3) return "benign";
  return "elevated";
}

const CLASSIFICATION_COLORS: Record<VpinResponse["classification"], string> = {
  toxic: "var(--color-bear)",
  elevated: "var(--color-warning)",
  benign: "var(--color-bull)",
};

const BADGE_VARIANTS: Record<
  VpinResponse["classification"],
  "bear" | "warning" | "bull"
> = {
  toxic: "bear",
  elevated: "warning",
  benign: "bull",
};

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
// VpinSparkline — a minimal inline SVG sparkline
// ---------------------------------------------------------------------------

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color: string;
}

function VpinSparkline({ values, width = 120, height = 32, color }: SparklineProps) {
  if (!values || values.length === 0) return null;

  const min = 0;
  const max = 1;
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = points.join(" ");

  return (
    <svg
      data-testid="vpin-sparkline"
      aria-label="VPIN history"
      role="img"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      className="overflow-visible"
    >
      {/* Reference lines at 0.3 and 0.7 */}
      <line
        x1={0}
        y1={(height - (0.7 / range) * height).toFixed(1)}
        x2={width}
        y2={(height - (0.7 / range) * height).toFixed(1)}
        stroke="var(--color-bear)"
        strokeWidth="0.5"
        strokeDasharray="2 2"
        opacity={0.4}
      />
      <line
        x1={0}
        y1={(height - (0.3 / range) * height).toFixed(1)}
        x2={width}
        y2={(height - (0.3 / range) * height).toFixed(1)}
        stroke="var(--color-bull)"
        strokeWidth="0.5"
        strokeDasharray="2 2"
        opacity={0.4}
      />
      {/* Sparkline */}
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Last value dot */}
      {values.length > 0 && (() => {
        const last = values[values.length - 1];
        const lx = width;
        const ly = height - ((last - min) / range) * height;
        return (
          <circle
            cx={lx.toFixed(1)}
            cy={ly.toFixed(1)}
            r={2.5}
            fill={color}
          />
        );
      })()}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// VpinGauge — horizontal gauge bar
// ---------------------------------------------------------------------------

function VpinGauge({ vpin }: { vpin: number }) {
  const clamped = Math.max(0, Math.min(1, vpin));
  const pct = (clamped * 100).toFixed(1);

  // Background gradient: green → amber → red
  const fillColor =
    clamped >= 0.7
      ? "var(--color-bear)"
      : clamped >= 0.3
        ? "var(--color-warning)"
        : "var(--color-bull)";

  return (
    <div
      role="meter"
      aria-label={`VPIN gauge: ${pct}%`}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={1}
      data-testid="vpin-gauge"
      className="relative w-full"
    >
      {/* Track */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
        {/* Fill */}
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: fillColor,
          }}
        />
      </div>
      {/* Tick marks at 0.3 and 0.7 */}
      <div className="pointer-events-none absolute inset-0 flex">
        <div
          className="absolute h-full w-px bg-[var(--color-border)]"
          style={{ left: "30%" }}
        />
        <div
          className="absolute h-full w-px bg-[var(--color-border)]"
          style={{ left: "70%" }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * OrderFlowPanel — displays the VPIN order-flow toxicity indicator.
 *
 * Shows a horizontal gauge (red = toxic ≥ 0.7, amber = elevated 0.3–0.7,
 * green = benign < 0.3), a sparkline of the last 20 VPIN bucket values,
 * a classification label, and the numeric VPIN value.
 *
 * Degrades gracefully: shows UnavailableBadge when available === false,
 * and a loading skeleton while data is in-flight.
 *
 * Validates: Requirements 7.5, 7.6, 7.7
 */
export function OrderFlowPanel({
  symbol = "NIFTY",
  intervalMs,
}: OrderFlowPanelProps) {
  const { data, isLoading } = useOrderFlow(symbol, intervalMs);

  // Loading state
  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Order Flow (VPIN)</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            data-testid="skeleton"
            role="status"
            aria-label="Loading order flow data"
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-8 w-full" />
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
          <CardTitle>Order Flow (VPIN)</CardTitle>
        </CardHeader>
        <CardContent>
          <UnavailableBadge reason={data?.reason} />
        </CardContent>
      </Card>
    );
  }

  // Available state
  const vpin = data.vpin ?? 0;
  const bucketHistory = data.bucketHistory ?? [];
  const classification = data.classification ?? classify(vpin);
  const fillColor = CLASSIFICATION_COLORS[classification];
  const badgeVariant = BADGE_VARIANTS[classification];
  const classificationLabel =
    classification.charAt(0).toUpperCase() + classification.slice(1);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Order Flow (VPIN)</CardTitle>
          <Badge variant={badgeVariant}>{classificationLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {/* Gauge + numeric value row */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <VpinGauge vpin={vpin} />
              <div className="mt-1 flex justify-between text-[10px] text-[var(--color-fg-subtle)]">
                <span>0</span>
                <span>0.3</span>
                <span>0.7</span>
                <span>1.0</span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <span
                className="text-lg font-semibold tabular-nums"
                style={{ color: fillColor }}
              >
                {vpin.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Sparkline */}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-[var(--color-fg-subtle)]">
              Last 20 buckets
            </span>
            <VpinSparkline
              values={bucketHistory}
              color={fillColor}
            />
          </div>

          {/* Symbol + last updated */}
          <div className="flex items-center justify-between text-[11px] text-[var(--color-fg-subtle)]">
            <span>{symbol}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
