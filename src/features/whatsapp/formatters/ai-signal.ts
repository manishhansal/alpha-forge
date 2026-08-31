/**
 * WhatsApp message formatter for AI Signal notifications.
 *
 * Formats an `AiSignalEvent` into a human-readable WhatsApp message for
 * Indian F&O traders. Includes entry/SL/TP levels in ₹, confidence metrics,
 * top 3 rationale bullets, optional strike for index underlyings, and the
 * [ML ✓] tag when the signal was ML-enhanced.
 *
 * References:
 *   - AiSignal interface  — src/types/ai-signals.ts
 *   - AiSignalEvent       — src/features/whatsapp/types.ts
 *   - Shared helpers      — src/features/whatsapp/formatters/shared.ts
 *
 * Requirements: 5.2, 5.3, 5.5, 5.6, 9.1–9.5
 */

import type { AiSignalEvent } from "@/features/whatsapp/types";
import {
  actionEmoji,
  formatINR,
  isIndexSymbol,
  messageFooter,
} from "@/features/whatsapp/formatters/shared";

/**
 * Capitalise the first letter of a string and lowercase the rest.
 * Used to convert AiHorizon values like "intraday" → "Intraday".
 */
function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Format an `AiSignalEvent` into a WhatsApp message string.
 *
 * Message layout:
 * ```
 * 🟢 RELIANCE — LONG [ML ✓]
 * NSE • Intraday
 *
 * Confidence: 82/100 (Grade A)
 * Entry:    ₹2,345.50
 * SL:       ₹2,290.00
 * TP1:      ₹2,410.00
 * TP2:      ₹2,480.00
 * TP3:      ₹2,550.00
 *
 * R:R 2.8 • Win: 68%
 *
 * Rationale:
 * • Strong breakout above resistance
 * • Rising OI with price appreciation
 * • RSI divergence on 15m chart
 *
 * AlphaForge • NSE F&O • 10:32 IST
 * ```
 *
 * For index underlyings with a non-null `strike`, a "Strike:" line is
 * appended before the footer.
 *
 * @param event - The `AI_SIGNAL_NEW` notification event
 */
export function formatAiSignalMessage(event: AiSignalEvent): string {
  const { signal } = event;
  const {
    symbol,
    action,
    confidenceScore,
    grade,
    entry,
    stopLoss,
    takeProfits,
    riskReward,
    winProbability,
    horizon,
    reasons,
    strike,
    mlEnhanced,
  } = signal;

  const isIndex = isIndexSymbol(symbol);

  // ─── Header line ──────────────────────────────────────────────────────────
  // Format: "🟢 RELIANCE — LONG [ML ✓]"
  const emoji = actionEmoji(action);
  const mlTag = mlEnhanced === true ? " [ML ✓]" : "";
  const headerLine = `${emoji} ${symbol} — ${action}${mlTag}`;

  // ─── Sub-header: exchange + horizon ──────────────────────────────────────
  // Derive exchange label: index symbols trade on NSE, equities default to NSE
  const exchangeLabel = "NSE";
  const horizonLabel = capitalise(horizon);
  const subHeader = `${exchangeLabel} • ${horizonLabel}`;

  // ─── Confidence and grade ─────────────────────────────────────────────────
  const confidenceLine = `Confidence: ${confidenceScore}/100 (Grade ${grade})`;

  // ─── Price levels ─────────────────────────────────────────────────────────
  const entryLine = `Entry:    ${formatINR(entry, isIndex)}`;
  const slLine = `SL:       ${formatINR(stopLoss, isIndex)}`;

  // Extract TP1, TP2, TP3 from takeProfits array (sorted by level)
  const sorted = [...takeProfits].sort((a, b) => a.level - b.level);
  const tp1 = sorted.find((tp) => tp.level === 1);
  const tp2 = sorted.find((tp) => tp.level === 2);
  const tp3 = sorted.find((tp) => tp.level === 3);

  const tpLines: string[] = [];
  if (tp1) tpLines.push(`TP1:      ${formatINR(tp1.price, isIndex)}`);
  if (tp2) tpLines.push(`TP2:      ${formatINR(tp2.price, isIndex)}`);
  if (tp3) tpLines.push(`TP3:      ${formatINR(tp3.price, isIndex)}`);

  // ─── Risk metrics ─────────────────────────────────────────────────────────
  // riskReward: already a ratio (e.g. 2.8), winProbability: [0,1] → show as %
  const rrFormatted = riskReward.toFixed(1);
  const winPct = Math.round(winProbability * 100);
  const metricsLine = `R:R ${rrFormatted} • Win: ${winPct}%`;

  // ─── Rationale bullets (top 3) ────────────────────────────────────────────
  const topReasons = reasons.slice(0, 3);
  const rationaleLines: string[] =
    topReasons.length > 0
      ? ["Rationale:", ...topReasons.map((r) => `• ${r.text}`)]
      : [];

  // ─── Strike line (index underlyings only) ─────────────────────────────────
  // Requirement 5.3: include the strike field when signal is for an index
  // underlying and strike is non-null. `AiSignal.strike` is the nearest ATM
  // option strike price (a number, e.g. 23400). Format it with integer Indian
  // notation since index strikes are whole numbers.
  const strikeLines: string[] = [];
  if (isIndex && strike !== null && strike !== undefined) {
    // Format the strike as an integer index price (no decimals)
    strikeLines.push(`Strike: ${formatINR(strike, true)}`);
  }

  // ─── Assemble message ────────────────────────────────────────────────────
  const parts: string[] = [
    headerLine,
    subHeader,
    "",
    confidenceLine,
    entryLine,
    slLine,
    ...tpLines,
    "",
    metricsLine,
  ];

  if (rationaleLines.length > 0) {
    parts.push("", ...rationaleLines);
  }

  if (strikeLines.length > 0) {
    parts.push("", ...strikeLines);
  }

  parts.push("", messageFooter());

  return parts.join("\n");
}
