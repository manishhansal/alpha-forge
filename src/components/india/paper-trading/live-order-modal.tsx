"use client";

/**
 * LiveOrderModal — double-confirm UX for placing a real order from a paper
 * trading signal.
 *
 * Design rules:
 *   - Shows signal details: symbol, direction, entry, stop, target.
 *   - Shows the strategy's current paper-trade win rate as a percentage.
 *   - Surfaces a warning badge when win rate < 50%.
 *   - "Place Real Order" CTA is disabled until the user checks the explicit
 *     confirmation checkbox ("I understand this places a real order").
 *
 * Accessibility:
 *   - Checkbox has an associated <label> element for screen-reader support.
 *   - Modal root carries role="dialog" and aria-modal="true".
 *   - CTA button is aria-disabled when the checkbox is unchecked.
 *
 * Requirements: 12.5, 12.6
 */

import { useState, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = "LONG" | "SHORT";

export interface LiveOrderSignal {
  symbol: string;
  direction: SignalDirection;
  entry: number;
  stop: number;
  target: number;
  strategyId?: string;
}

export interface LiveOrderModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (signal: LiveOrderSignal) => void;
  signal: LiveOrderSignal;
  /** Paper-trade win rate in [0, 1]. E.g. 0.65 = 65%. */
  paperWinRate: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LiveOrderModal({
  open,
  onClose,
  onConfirm,
  signal,
  paperWinRate,
}: LiveOrderModalProps) {
  const [confirmed, setConfirmed] = useState(false);
  const checkboxId = useId();

  const isLowWinRate = paperWinRate < 0.5;
  const winRatePct = formatPct(paperWinRate);

  if (!open) return null;

  function handleConfirm() {
    if (!confirmed) return;
    onConfirm(signal);
  }

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Modal root */}
      <div
        data-testid="live-order-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="live-order-modal-title"
        className="relative w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="live-order-modal-title"
            className="text-base font-semibold tracking-tight text-[var(--color-fg)]"
          >
            Place Real Order
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-md p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
          >
            ✕
          </button>
        </div>

        {/* Signal details */}
        <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-lg font-bold tracking-tight text-[var(--color-fg)]">
              {signal.symbol}
            </span>
            <Badge
              variant={signal.direction === "LONG" ? "bull" : "bear"}
              aria-label={`Direction: ${signal.direction}`}
            >
              {signal.direction}
            </Badge>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Entry
              </p>
              <p className="mt-0.5 font-semibold tabular-nums text-[var(--color-fg)]">
                ₹{formatPrice(signal.entry)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Stop
              </p>
              <p className="mt-0.5 font-semibold tabular-nums text-[var(--color-bear)]">
                ₹{formatPrice(signal.stop)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Target
              </p>
              <p className="mt-0.5 font-semibold tabular-nums text-[var(--color-bull)]">
                ₹{formatPrice(signal.target)}
              </p>
            </div>
          </div>
        </div>

        {/* Win rate row */}
        <div className="mb-4 flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Paper-trade win rate
            </p>
            <p
              className={cn(
                "mt-0.5 text-base font-semibold tabular-nums",
                isLowWinRate
                  ? "text-[var(--color-bear)]"
                  : "text-[var(--color-bull)]",
              )}
            >
              {winRatePct}
            </p>
          </div>

          {/* Warning badge — only shown when win rate < 50% */}
          {isLowWinRate && (
            <Badge
              variant="warning"
              data-testid="win-rate-warning"
              role="alert"
              aria-label={`Warning: win rate ${winRatePct} is below 50%`}
            >
              ⚠ Below 50%
            </Badge>
          )}
        </div>

        {/* Disclaimer text for low win rate */}
        {isLowWinRate && (
          <p className="mb-4 rounded-lg border border-[color-mix(in_oklch,var(--color-warning)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)] px-3 py-2 text-xs text-[var(--color-warning)]">
            Warning: this strategy has a paper-trade win rate of {winRatePct} — below 50%. Placing a
            real order carries elevated risk.
          </p>
        )}

        {/* Confirmation checkbox */}
        <div className="mb-5 flex items-start gap-3">
          <input
            id={checkboxId}
            data-testid="confirm-checkbox"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            aria-label="I understand this places a real order with real money"
            className="mt-0.5 h-4 w-4 cursor-pointer rounded border-[var(--color-border)] accent-[var(--color-brand)]"
          />
          <label
            htmlFor={checkboxId}
            className="cursor-pointer text-sm text-[var(--color-fg-muted)] leading-snug"
          >
            I understand this places a <strong className="text-[var(--color-fg)]">real order</strong>{" "}
            with real money. Paper-trade results do not guarantee live performance.
          </label>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={onClose}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            data-testid="place-order-btn"
            variant={confirmed ? "danger" : "secondary"}
            size="md"
            disabled={!confirmed}
            onClick={handleConfirm}
            aria-disabled={!confirmed}
            className="flex-1"
          >
            Place Real Order
          </Button>
        </div>
      </div>
    </div>
  );
}
