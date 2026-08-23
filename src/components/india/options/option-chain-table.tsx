"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Activity } from "lucide-react";
import type { OptionChain, OptionLeg } from "@/types/india";
import { fmt, fmtCompact } from "@/lib/india/format";
import { fmtTime } from "@/lib/utils";
import { useIndiaOptionChainStore } from "@/store/india/optionChainStore";

type Props = {
  data: OptionChain;
  loading?: boolean;
  /** How many strikes to show on each side of ATM. */
  spread?: number;
};

function pickAtmIndex(rows: OptionChain["rows"], spot: number | null): number {
  if (spot == null || rows.length === 0) return 0;
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const d = Math.abs(rows[i].strike - spot);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return idx;
}

function legBg(leg: OptionLeg | null, side: "ce" | "pe"): string {
  if (!leg) return "";
  const change = leg.changeInOi;
  if (change > 0) {
    return side === "ce"
      ? "bg-[color-mix(in_oklch,var(--bear)_8%,transparent)]"
      : "bg-[color-mix(in_oklch,var(--bull)_8%,transparent)]";
  }
  if (change < 0) {
    return side === "ce"
      ? "bg-[color-mix(in_oklch,var(--bull)_8%,transparent)]"
      : "bg-[color-mix(in_oklch,var(--bear)_8%,transparent)]";
  }
  return "";
}

export function OptionChainTable({ data, loading, spread = 10 }: Props) {
  const setExpiry = useIndiaOptionChainStore((s) => s.setExpiry);
  const [showGreeks, setShowGreeks] = React.useState(false);
  const atm = pickAtmIndex(data.rows, data.spot);
  const start = Math.max(0, atm - spread);
  const end = Math.min(data.rows.length, atm + spread + 1);
  const visible = data.rows.slice(start, end);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-start justify-between">
        <div className="flex flex-wrap gap-1.5">
          {data.expiries.slice(0, 6).map((e) => {
            const active = e === data.expiry;
            return (
              <button
                key={e}
                onClick={() => setExpiry(e)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                  active
                    ? "bg-[var(--color-fg)] text-[var(--color-bg)] border-transparent"
                    : "bg-[var(--color-surface)]/40 text-[var(--color-fg-muted)] border-[var(--color-border)]/60 hover:text-[var(--color-fg)]"
                }`}
              >
                {e}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-muted)]">
          <button
            type="button"
            onClick={() => setShowGreeks((v) => !v)}
            aria-pressed={showGreeks}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
              showGreeks
                ? "bg-[var(--color-fg)] text-[var(--color-bg)] border-transparent"
                : "bg-[var(--color-surface)]/40 text-[var(--color-fg-muted)] border-[var(--color-border)]/60 hover:text-[var(--color-fg)]"
            }`}
          >
            Greeks
          </button>
          {loading && (
            <span className="flex items-center gap-1 text-[var(--color-info)]">
              <Activity className="h-3 w-3 animate-pulse" />
              refreshing
            </span>
          )}
          {data.fetchedAt && (
            <span>updated {fmtTime(data.fetchedAt)}</span>
          )}
        </div>
      </div>

      <AnalyticsBar data={data} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="glass rounded-2xl overflow-hidden"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-surface)]/40">
              <tr className="text-[var(--color-fg-muted)] uppercase tracking-wide">
                <th
                  colSpan={showGreeks ? 5 : 4}
                  className="text-center py-2 font-semibold text-[var(--color-bull)]"
                >
                  CALLS
                </th>
                <th className="py-2 px-3 text-center font-semibold text-[var(--color-fg)]">
                  Strike
                </th>
                <th
                  colSpan={showGreeks ? 5 : 4}
                  className="text-center py-2 font-semibold text-[var(--color-bear)]"
                >
                  PUTS
                </th>
              </tr>
              <tr className="text-[10px] text-[var(--color-fg-muted)] border-b border-[var(--color-border)]/60">
                <th className="p-1.5 text-right">OI</th>
                <th className="p-1.5 text-right">ΔOI</th>
                <th className="p-1.5 text-right">IV</th>
                {showGreeks && <th className="p-1.5 text-right">Δ</th>}
                <th className="p-1.5 text-right">LTP</th>
                <th className="p-1.5 text-center font-semibold">—</th>
                <th className="p-1.5 text-right">LTP</th>
                {showGreeks && <th className="p-1.5 text-right">Δ</th>}
                <th className="p-1.5 text-right">IV</th>
                <th className="p-1.5 text-right">ΔOI</th>
                <th className="p-1.5 text-right">OI</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const stepSize =
                  data.rows[1]?.strike != null && data.rows[0]?.strike != null
                    ? data.rows[1].strike - data.rows[0].strike
                    : 50;
                const isAtm =
                  data.spot != null &&
                  Math.abs(row.strike - data.spot) < 0.5 * stepSize;
                const ce = row.ce;
                const pe = row.pe;
                return (
                  <tr
                    key={row.strike}
                    className={`border-b border-[var(--color-border)]/30 ${
                      isAtm ? "bg-[color-mix(in_oklch,var(--warning)_10%,transparent)]" : ""
                    } hover:bg-[var(--color-surface-hover)] transition-colors`}
                  >
                    <td className={`p-1.5 text-right tabular ${legBg(ce, "ce")}`}>
                      {ce ? fmtCompact(ce.oi) : "—"}
                    </td>
                    <td className={`p-1.5 text-right tabular ${legBg(ce, "ce")}`}>
                      <span
                        className={
                          ce && ce.changeInOi > 0
                            ? "text-[var(--color-bear)]"
                            : ce && ce.changeInOi < 0
                              ? "text-[var(--color-bull)]"
                              : ""
                        }
                      >
                        {ce ? fmtCompact(ce.changeInOi) : "—"}
                      </span>
                    </td>
                    <td className={`p-1.5 text-right tabular ${legBg(ce, "ce")}`}>
                      {ce?.iv ? `${ce.iv.toFixed(1)}` : "—"}
                    </td>
                    {showGreeks && (
                      <td
                        className={`p-1.5 text-right tabular ${legBg(ce, "ce")}`}
                      >
                        {ce?.delta != null ? ce.delta.toFixed(2) : "—"}
                      </td>
                    )}
                    <td
                      className={`p-1.5 text-right tabular font-medium ${legBg(ce, "ce")}`}
                    >
                      {ce?.ltp != null ? fmt(ce.ltp) : "—"}
                    </td>
                    <td className="p-1.5 text-center font-semibold tabular bg-[var(--color-surface)]/20">
                      {row.strike}
                    </td>
                    <td
                      className={`p-1.5 text-right tabular font-medium ${legBg(pe, "pe")}`}
                    >
                      {pe?.ltp != null ? fmt(pe.ltp) : "—"}
                    </td>
                    {showGreeks && (
                      <td
                        className={`p-1.5 text-right tabular ${legBg(pe, "pe")}`}
                      >
                        {pe?.delta != null ? pe.delta.toFixed(2) : "—"}
                      </td>
                    )}
                    <td className={`p-1.5 text-right tabular ${legBg(pe, "pe")}`}>
                      {pe?.iv ? `${pe.iv.toFixed(1)}` : "—"}
                    </td>
                    <td className={`p-1.5 text-right tabular ${legBg(pe, "pe")}`}>
                      <span
                        className={
                          pe && pe.changeInOi > 0
                            ? "text-[var(--color-bull)]"
                            : pe && pe.changeInOi < 0
                              ? "text-[var(--color-bear)]"
                              : ""
                        }
                      >
                        {pe ? fmtCompact(pe.changeInOi) : "—"}
                      </span>
                    </td>
                    <td className={`p-1.5 text-right tabular ${legBg(pe, "pe")}`}>
                      {pe ? fmtCompact(pe.oi) : "—"}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={showGreeks ? 11 : 9}
                    className="p-8 text-center text-[var(--color-fg-muted)]"
                  >
                    No option chain rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}

function AnalyticsBar({ data }: { data: OptionChain }) {
  const a = data.analytics;
  const pcrTone =
    a.pcrOi == null
      ? ""
      : a.pcrOi > 1.3
        ? "text-[var(--color-bull)]"
        : a.pcrOi < 0.7
          ? "text-[var(--color-bear)]"
          : "text-[var(--color-fg)]";
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <Tile label="Spot" value={fmt(data.spot)} accent="text-[var(--color-fg)]" />
      <Tile
        label="PCR (OI)"
        value={a.pcrOi != null ? a.pcrOi.toFixed(2) : "—"}
        accent={pcrTone}
        sub={a.pcrVolume != null ? `Vol ${a.pcrVolume.toFixed(2)}` : undefined}
      />
      <Tile
        label="ATM IV"
        value={a.atmIv != null ? `${a.atmIv.toFixed(1)}%` : "—"}
      />
      <Tile
        label="Max Pain"
        value={a.maxPain != null ? String(a.maxPain) : "—"}
      />
      <Tile
        label="Max CE OI"
        value={a.maxCeOiStrike != null ? String(a.maxCeOiStrike) : "—"}
        accent="text-[var(--color-bear)]"
        sub={`Resistance · ${fmtCompact(a.totalCeOi)}`}
      />
      <Tile
        label="Max PE OI"
        value={a.maxPeOiStrike != null ? String(a.maxPeOiStrike) : "—"}
        accent="text-[var(--color-bull)]"
        sub={`Support · ${fmtCompact(a.totalPeOi)}`}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  accent = "text-[var(--color-fg)]",
  sub,
}: {
  label: string;
  value: string;
  accent?: string;
  sub?: string;
}) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular ${accent}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-[var(--color-fg-muted)] mt-0.5 truncate">
          {sub}
        </div>
      )}
    </div>
  );
}
