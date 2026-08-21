/**
 * IV Regime Badge — displays the IV regime classification from the
 * PatchTST classifier (`POST /predict/iv-regime`).
 *
 * Shows "Crush" in green when sellers have edge (IV compression expected),
 * "Spike" in red when buyers have edge (IV expansion expected),
 * and "Stable" in a neutral tone for the middle regime.
 *
 * Renders nothing when `ivRegime` is null or undefined (e.g. model
 * untrained or ML service offline) — Requirement 9.6, 9.7.
 *
 * Validates: Requirements 9.8
 */

import React from "react";

// ─── Props ───────────────────────────────────────────────────────────────────

export interface IvRegimeBadgeProps {
  /** The IV regime from the classifier. Null/undefined → badge absent. */
  ivRegime: "CRUSH" | "STABLE" | "SPIKE" | null | undefined;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Named export used by the option chain page and AI engine.
 */
export function IvRegimeBadge({ ivRegime }: IvRegimeBadgeProps): React.ReactElement | null {
  if (ivRegime == null) {
    // Requirement 9.6: iv_regime may be null — render nothing, never crash.
    return null;
  }

  if (ivRegime === "CRUSH") {
    return (
      <span
        className="iv-regime-badge iv-regime-green text-green-600 font-medium text-xs px-2 py-0.5 rounded bg-green-50 border border-green-200"
        data-regime="CRUSH"
        data-testid="iv-regime-badge"
      >
        Crush
      </span>
    );
  }

  if (ivRegime === "SPIKE") {
    return (
      <span
        className="iv-regime-badge iv-regime-red text-red-600 font-medium text-xs px-2 py-0.5 rounded bg-red-50 border border-red-200"
        data-regime="SPIKE"
        data-testid="iv-regime-badge"
      >
        Spike
      </span>
    );
  }

  // STABLE
  return (
    <span
      className="iv-regime-badge iv-regime-stable text-yellow-600 font-medium text-xs px-2 py-0.5 rounded bg-yellow-50 border border-yellow-200"
      data-regime="STABLE"
      data-testid="iv-regime-badge"
    >
      Stable
    </span>
  );
}
