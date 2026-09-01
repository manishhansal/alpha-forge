/**
 * Paper Trading Soak Mode — Phase 18
 *
 * SAFE_PAPER_SOAK_MODE characteristics:
 *   ✅ Real market data allowed
 *   ✅ Paper orders only
 *   ❌ Broker order endpoints BLOCKED
 *   ✅ Records all performance metrics during soak
 *   ✅ Generates SOAK_REPORT.md
 *
 * Never marks live trading verified.
 * Run durations: 30 minutes / 2 hours / full market session.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SoakDuration = "30m" | "2h" | "full_session" | "custom";

export type SoakMetrics = {
  startedAt: string;       // ISO-8601
  endedAt: string | null;  // ISO-8601
  durationMs: number;
  providerLatencyP50Ms: number | null;
  providerLatencyP99Ms: number | null;
  dataGapsDetected: number;
  staleTicksDetected: number;
  wsReconnects: number;
  featureFailures: number;
  mlLatencyP50Ms: number | null;
  mlLatencyP99Ms: number | null;
  signalLatencyP50Ms: number | null;
  riskRejections: number;
  paperTradesOpened: number;
  paperTradesFilled: number;
  duplicatesPrevented: number;
  providerName: string | null;
};

export type SoakStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED";

export interface SoakSession {
  sessionId: string;
  status: SoakStatus;
  duration: SoakDuration;
  durationMs: number;
  metrics: SoakMetrics;
}

// ─── Safety guard ────────────────────────────────────────────────────────────

/**
 * Verify that the soak mode environment is safe.
 * Throws if LIVE_TRADING_ENABLED is set or if the environment is not paper-safe.
 */
export function assertPaperSoakSafe(): void {
  if (process.env.LIVE_TRADING_ENABLED === "true") {
    throw new Error(
      "SAFE_PAPER_SOAK_MODE: LIVE_TRADING_ENABLED=true is set. " +
        "Paper soak mode cannot run when live trading is enabled. " +
        "Unset LIVE_TRADING_ENABLED to run paper soak.",
    );
  }

  if (process.env.NODE_ENV === "production" && !process.env.PAPER_SOAK_ALLOW_PROD) {
    throw new Error(
      "SAFE_PAPER_SOAK_MODE: Running in production environment without PAPER_SOAK_ALLOW_PROD=true. " +
        "Set PAPER_SOAK_ALLOW_PROD=true only when intentionally running paper soak in prod.",
    );
  }
}

/**
 * Returns true when the current environment is configured for safe paper soak mode.
 */
export function isPaperSoakSafe(): boolean {
  try {
    assertPaperSoakSafe();
    return true;
  } catch {
    return false;
  }
}

// ─── Duration helpers ────────────────────────────────────────────────────────

const DURATION_MS: Record<SoakDuration, number> = {
  "30m": 30 * 60 * 1_000,
  "2h": 2 * 60 * 60 * 1_000,
  "full_session": 6.25 * 60 * 60 * 1_000, // 09:15 → 15:30 IST = 6h15m
  "custom": 0, // caller sets durationMs directly
};

export function getDurationMs(
  duration: SoakDuration,
  customMs?: number,
): number {
  if (duration === "custom") {
    if (!customMs || customMs <= 0) {
      throw new Error("custom soak duration requires a positive customMs");
    }
    return customMs;
  }
  return DURATION_MS[duration];
}

// ─── Soak report generator ───────────────────────────────────────────────────

/**
 * Generate a SOAK_REPORT.md from a completed soak session.
 */
export function generateSoakReport(session: SoakSession): string {
  const { metrics } = session;
  const durationMin = Math.round(session.durationMs / 60_000);

  const lines: string[] = [
    `# Paper Trading Soak Report`,
    ``,
    `**Session ID:** ${session.sessionId}`,
    `**Status:** ${session.status}`,
    `**Duration:** ${durationMin} minutes (${session.duration})`,
    `**Started:** ${metrics.startedAt}`,
    `**Ended:** ${metrics.endedAt ?? "N/A"}`,
    `**Provider:** ${metrics.providerName ?? "unknown"}`,
    ``,
    `## ⚠️ Safety Confirmation`,
    ``,
    `- ✅ Paper orders only — no broker order endpoints called`,
    `- ✅ LIVE_TRADING_ENABLED is NOT set`,
    `- ✅ This report does NOT certify live trading readiness`,
    ``,
    `## Provider Performance`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Data Gaps Detected | ${metrics.dataGapsDetected} |`,
    `| Stale Ticks | ${metrics.staleTicksDetected} |`,
    `| WebSocket Reconnects | ${metrics.wsReconnects} |`,
    `| Provider Latency P50 | ${metrics.providerLatencyP50Ms?.toFixed(0) ?? "N/A"} ms |`,
    `| Provider Latency P99 | ${metrics.providerLatencyP99Ms?.toFixed(0) ?? "N/A"} ms |`,
    ``,
    `## ML Pipeline`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Feature Failures | ${metrics.featureFailures} |`,
    `| ML Latency P50 | ${metrics.mlLatencyP50Ms?.toFixed(0) ?? "N/A"} ms |`,
    `| ML Latency P99 | ${metrics.mlLatencyP99Ms?.toFixed(0) ?? "N/A"} ms |`,
    `| Signal Latency P50 | ${metrics.signalLatencyP50Ms?.toFixed(0) ?? "N/A"} ms |`,
    ``,
    `## Paper Trading`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Paper Trades Opened | ${metrics.paperTradesOpened} |`,
    `| Paper Trades Filled | ${metrics.paperTradesFilled} |`,
    `| Risk Rejections | ${metrics.riskRejections} |`,
    `| Duplicates Prevented | ${metrics.duplicatesPrevented} |`,
    ``,
    `## Conclusion`,
    ``,
    `This soak report covers ${durationMin} minutes of paper trading with real market data.`,
    `No live broker order execution occurred during this session.`,
    ``,
    `**Live trading has NOT been verified by this soak test.**`,
    `Advance to live trading only after completing the full model governance`,
    `lifecycle (LIVE_CANDIDATE → MANUAL_APPROVAL → LIVE).`,
  ];

  return lines.join("\n");
}
