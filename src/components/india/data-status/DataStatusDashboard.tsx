"use client";

/**
 * DataStatusDashboard.tsx — V8 Historical Data Status UI
 *
 * Client component that fetches and displays:
 *   1. Overall health summary
 *   2. F&O Universe (constituent count, lifecycle)
 *   3. Timeframe coverage (all 9 supported, 3m NOT shown)
 *   4. Provider matrix (authenticated vs open-source, clearly distinguished)
 *   5. Gap summary
 *   6. Reconciliation statistics
 *   7. 3m removal audit
 *
 * Answers §24: "Who provided this data? Was the source authenticated?"
 * Displays clear status badges: VERIFIED / PARTIAL / DEGRADED / BLOCKED / UNAVAILABLE / STALE
 */

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusData {
  generatedAt: string;
  fnoUniverse: {
    constituentCount: number;
    fnoEquityCount: number;
    fnoIndexCount: number;
    addedCount: number;
    removedCount: number;
    universeVersion: string;
    sourceProvider: string;
  } | null;
  timeframeCoverage: Record<string, { rows: number; lastUpdated: string | null }>;
  supportedTimeframes: string[];
  threeMRemoval: {
    legacyRowsInDb: number;
    newAcquisitionsBlocked: boolean;
    note: string;
  };
  qualityDistribution: Record<string, number>;
  gapSummary: { pending: number; recovered: number; distribution: Record<string, number> };
  reconciliation: Record<string, number>;
  backfillJobs: Record<string, number>;
  providerActivity: Record<string, number>;
  healthSummary: {
    universeCurrent: boolean;
    dataQualityVerified: number | null;
    pendingGaps: number;
    overallStatus: string;
  };
}

interface Provider {
  provider: string;
  sourceType: string;
  authenticated: boolean;
  authenticationLabel: string;
  note: string;
  candleRowsInDb: number;
  provenanceRows: number;
  verifiedRows: number;
  reliabilityStatus: string;
  successRate: number | null;
  supportedIntervals: string[];
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  VERIFIED:          "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  VERIFIED_RECONCILED: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  DATA_READY:        "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  DEGRADED:          "bg-amber-500/20 text-amber-400 border-amber-500/30",
  DATA_DEGRADED:     "bg-amber-500/20 text-amber-400 border-amber-500/30",
  PARTIAL:           "bg-amber-500/20 text-amber-400 border-amber-500/30",
  BLOCKED:           "bg-red-500/20 text-red-400 border-red-500/30",
  UNAVAILABLE:       "bg-neutral-500/20 text-neutral-400 border-neutral-500/30",
  STALE:             "bg-orange-500/20 text-orange-400 border-orange-500/30",
  PENDING:           "bg-sky-500/20 text-sky-400 border-sky-500/30",
  DATA_INSUFFICIENT: "bg-neutral-500/20 text-neutral-400 border-neutral-500/30",
  BROKER_AUTHENTICATED:    "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  OPEN_SOURCE_NSE_DERIVED: "bg-sky-500/20 text-sky-400 border-sky-500/30",
  YAHOO_FALLBACK:          "bg-orange-500/20 text-orange-400 border-orange-500/30",
  UNKNOWN:                 "bg-neutral-500/20 text-neutral-400 border-neutral-500/30",
};

function StatusBadge({ status, label }: { status: string; label?: string }) {
  const cls = STATUS_COLORS[status] ?? STATUS_COLORS.UNKNOWN;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {label ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export function DataStatusDashboard() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [statusRes, provRes] = await Promise.all([
          fetch("/api/in/historical-data/status"),
          fetch("/api/in/historical-data/providers"),
        ]);
        const statusData = await statusRes.json();
        const provData = await provRes.json();
        setStatus(statusData);
        setProviders(provData.providers ?? []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  if (loading) {
    return (
      <div className="text-neutral-400 text-sm animate-pulse">
        Loading historical data status from live DB…
      </div>
    );
  }
  if (error || !status) {
    return (
      <div className="text-red-400 text-sm border border-red-500/30 rounded p-4 bg-red-500/10">
        {error ?? "Failed to load status"}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overall Health */}
      <Section title="Overall Health">
        <div className="flex flex-wrap gap-4 items-center">
          <StatusBadge status={status.healthSummary.overallStatus} />
          <span className="text-sm text-neutral-400">
            Generated: {new Date(status.generatedAt).toLocaleString()}
          </span>
          {status.healthSummary.dataQualityVerified !== null && (
            <span className="text-sm text-neutral-300">
              Quality verified: <strong>{status.healthSummary.dataQualityVerified}%</strong>
            </span>
          )}
          {status.healthSummary.pendingGaps > 0 && (
            <span className="text-sm text-amber-400">
              {status.healthSummary.pendingGaps} pending gaps
            </span>
          )}
        </div>
      </Section>

      {/* 3m Removal Audit */}
      <Section title="3m Removal Audit" highlight="3m was permanently removed in V8">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <StatusBadge
              status={status.threeMRemoval.newAcquisitionsBlocked ? "VERIFIED" : "BLOCKED"}
              label={status.threeMRemoval.newAcquisitionsBlocked ? "NEW ACQUISITIONS BLOCKED" : "NOT BLOCKED — BUG"}
            />
            <span className="text-sm text-neutral-300">
              Legacy rows in DB (audit only): <strong>{status.threeMRemoval.legacyRowsInDb}</strong>
            </span>
          </div>
          <p className="text-xs text-neutral-500">{status.threeMRemoval.note}</p>
        </div>
      </Section>

      {/* F&O Universe */}
      <Section title="F&O Universe">
        {status.fnoUniverse ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="F&O Equity Stocks" value={status.fnoUniverse.fnoEquityCount} />
            <Stat label="F&O Index" value={status.fnoUniverse.fnoIndexCount} />
            <Stat label="Added (latest)" value={status.fnoUniverse.addedCount} color="emerald" />
            <Stat label="Removed (latest)" value={status.fnoUniverse.removedCount} color="red" />
            <div className="col-span-2">
              <p className="text-xs text-neutral-500">Version: {status.fnoUniverse.universeVersion}</p>
              <p className="text-xs text-neutral-500">Source: {status.fnoUniverse.sourceProvider}</p>
            </div>
          </div>
        ) : (
          <div className="text-amber-400 text-sm">
            No universe snapshot found. Run <code className="bg-neutral-800 px-1 rounded">npm run data:refresh-universe</code>
          </div>
        )}
      </Section>

      {/* Timeframe Coverage */}
      <Section title="Timeframe Coverage (Supported: 9 intervals — no 3m)">
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
          {status.supportedTimeframes.map((tf) => {
            const data = status.timeframeCoverage[tf];
            const rows = data?.rows ?? 0;
            return (
              <div key={tf} className="bg-neutral-800 rounded p-2 text-center">
                <p className="text-xs font-mono text-neutral-300 font-bold">{tf}</p>
                <p className="text-lg font-bold text-white">{rows.toLocaleString()}</p>
                <p className="text-xs text-neutral-500">rows</p>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-neutral-600 mt-2">
          Note: 3m is not shown because it is permanently out of scope (V8 removal). No new 3m data is acquired.
        </p>
      </Section>

      {/* Provider Matrix */}
      <Section title="Provider Matrix — Authentication & Data Volume">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500 border-b border-neutral-700">
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4">Authentication</th>
                <th className="pb-2 pr-4">Source Type</th>
                <th className="pb-2 pr-4">Candle Rows</th>
                <th className="pb-2 pr-4">Verified Rows</th>
                <th className="pb-2">Reliability</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.provider} className="border-b border-neutral-800">
                  <td className="py-2 pr-4 font-mono font-bold text-white">{p.provider}</td>
                  <td className="py-2 pr-4">
                    <StatusBadge
                      status={p.authenticated ? "BROKER_AUTHENTICATED" : p.sourceType}
                      label={p.authenticated ? "AUTHENTICATED" : "OPEN-SOURCE"}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={p.sourceType} label={p.sourceType.replace(/_/g, " ")} />
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{p.candleRowsInDb.toLocaleString()}</td>
                  <td className="py-2 pr-4 tabular-nums text-emerald-400">
                    {p.verifiedRows.toLocaleString()}
                  </td>
                  <td className="py-2">
                    <StatusBadge status={p.reliabilityStatus} />
                    {p.successRate !== null && (
                      <span className="ml-2 text-xs text-neutral-400">
                        {(p.successRate * 100).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-neutral-600 mt-2">
          AUTHENTICATED = broker credentials verified (Angel One / Upstox). OPEN-SOURCE = NSE-derived (Jugaad / OpenChart). YAHOO_FALLBACK = restricted last-resort.
        </p>
      </Section>

      {/* Quality Distribution */}
      <Section title="Data Quality Distribution">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Object.entries(status.qualityDistribution).map(([st, count]) => (
            <div key={st} className="bg-neutral-800 rounded p-3">
              <StatusBadge status={st} label={st.replace(/_/g, " ")} />
              <p className="text-xl font-bold text-white mt-2">{count}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Gap Summary */}
      <Section title="Data Gap Summary">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Pending Gaps" value={status.gapSummary.pending} color="amber" />
          <Stat label="Recovered Gaps" value={status.gapSummary.recovered} color="emerald" />
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
          {Object.entries(status.gapSummary.distribution).map(([st, count]) => (
            <div key={st} className="bg-neutral-800 rounded p-2 text-center text-xs">
              <p className="text-neutral-400">{st}</p>
              <p className="text-white font-bold text-sm">{count}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Reconciliation */}
      {Object.keys(status.reconciliation).length > 0 && (
        <Section title="Multi-Source Reconciliation">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {Object.entries(status.reconciliation).map(([st, count]) => (
              <div key={st} className="bg-neutral-800 rounded p-2 text-center text-xs">
                <StatusBadge status={st === "MATCHED" || st === "WITHIN_TOLERANCE" ? "VERIFIED" : "DEGRADED"}
                  label={st.replace(/_/g, " ")} />
                <p className="text-white font-bold text-sm mt-1">{count}</p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({
  title,
  highlight,
  children,
}: {
  title: string;
  highlight?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {highlight && (
          <span className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5">
            {highlight}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  color = "white",
}: {
  label: string;
  value: number | string;
  color?: "white" | "emerald" | "red" | "amber";
}) {
  const colorCls = {
    white:   "text-white",
    emerald: "text-emerald-400",
    red:     "text-red-400",
    amber:   "text-amber-400",
  }[color];
  return (
    <div className="bg-neutral-800 rounded p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`text-2xl font-bold ${colorCls}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
    </div>
  );
}
