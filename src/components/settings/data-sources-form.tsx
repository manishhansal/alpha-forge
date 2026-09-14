"use client";

import { CheckCircle2, Loader2, ServerCrash, Wifi } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * DataSourcesForm — data-service2.0 connection status display.
 *
 * Phase 3 of the data-service2.0 centralization refactor.
 *
 * Provider-specific data source selection (Angel One, Upstox, Yahoo, NSE,
 * Scrapling) has been removed. All market data is now served exclusively by
 * data-service2.0. This component shows:
 *   - The configured data-service2.0 URL
 *   - Live connection status (polled from /api/in/historical-data/status)
 *   - Per-provider health reported by data-service2.0
 */

interface ProviderHealthEntry {
  provider: string;
  status: string;
  latencyMs?: number | null;
  lastChecked?: string | null;
  errorMessage?: string | null;
}

interface StatusResponse {
  generatedAt: string;
  overallStatus: string;
  dataService: {
    health: {
      status: string;
      version?: string;
      uptime?: number;
    } | null;
    healthError: string | null;
  };
  providers: {
    list: ProviderHealthEntry[];
    error: string | null;
  };
}

type ConnectionState = "idle" | "loading" | "ok" | "error";

export function DataSourcesForm() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  const dataServiceUrl =
    typeof window !== "undefined"
      ? // The URL is server-only; show a placeholder in the browser.
        "(configured via DATA_SERVICE_2_URL env var)"
      : "";

  async function checkConnection() {
    setConnectionState("loading");
    setLastError(null);
    try {
      const res = await fetch("/api/in/historical-data/status", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as StatusResponse;
      setStatus(data);
      setConnectionState(
        data.overallStatus === "DATA_SERVICE_UNAVAILABLE" ? "error" : "ok"
      );
    } catch (err) {
      setConnectionState("error");
      setLastError((err as Error).message);
    }
  }

  // Check on mount
  useEffect(() => {
    void checkConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overallOk =
    connectionState === "ok" &&
    status?.overallStatus !== "DATA_SERVICE_UNAVAILABLE";

  return (
    <div className="flex flex-col gap-6">
      {/* ── Connection banner ── */}
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            data-service2.0 connection
          </p>
          <button
            type="button"
            onClick={() => void checkConnection()}
            disabled={connectionState === "loading"}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-fg)] transition-colors hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connectionState === "loading" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wifi className="h-3 w-3" />
            )}
            {connectionState === "loading" ? "Checking…" : "Refresh"}
          </button>
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            {connectionState === "loading" && (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
            )}
            {connectionState === "ok" && overallOk && (
              <CheckCircle2 className="h-4 w-4 text-[var(--color-bull)]" />
            )}
            {(connectionState === "error" ||
              (connectionState === "ok" && !overallOk)) && (
              <ServerCrash className="h-4 w-4 text-[var(--color-bear)]" />
            )}
            {connectionState === "idle" && (
              <div className="h-4 w-4 rounded-full border-2 border-[var(--color-border)]" />
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              {connectionState === "idle" && "Not checked"}
              {connectionState === "loading" && "Connecting…"}
              {connectionState === "ok" && overallOk && "Connected"}
              {connectionState === "ok" && !overallOk && "Degraded"}
              {connectionState === "error" && "Unavailable"}
            </p>
            <p className="text-[11px] text-[var(--color-fg-muted)]">
              URL: <span className="font-mono">{dataServiceUrl}</span>
            </p>
            {status?.dataService.health?.version && (
              <p className="text-[11px] text-[var(--color-fg-subtle)]">
                Version: {status.dataService.health.version}
              </p>
            )}
            {status?.generatedAt && (
              <p className="text-[11px] text-[var(--color-fg-subtle)]">
                Last checked: {new Date(status.generatedAt).toLocaleTimeString()}
              </p>
            )}
            {lastError && (
              <p className="mt-1 text-[11px] text-[var(--color-bear)]">
                Error: {lastError}
              </p>
            )}
            {status?.dataService.healthError && !lastError && (
              <p className="mt-1 text-[11px] text-[var(--color-warning)]">
                {status.dataService.healthError}
              </p>
            )}
          </div>
        </div>

        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          All market data — candles, option chains, quotes, F&O universe — is served
          exclusively by data-service2.0. Configure{" "}
          <span className="font-mono">DATA_SERVICE_2_URL</span> and{" "}
          <span className="font-mono">DATA_SERVICE_API_KEY</span> in your environment.
        </p>
      </div>

      {/* ── Provider health from data-service2.0 ── */}
      {status?.providers.list && status.providers.list.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            Provider health (via data-service2.0)
          </p>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {status.providers.list.map((p) => {
              const isUp = p.status === "ok" || p.status === "healthy";
              return (
                <div
                  key={p.provider}
                  className={[
                    "flex items-start gap-3 rounded-lg border px-3 py-2.5",
                    isUp
                      ? "border-[color-mix(in_oklch,var(--color-bull)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-bull)_5%,transparent)]"
                      : "border-[color-mix(in_oklch,var(--color-bear)_30%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-bear)_5%,transparent)]",
                  ].join(" ")}
                >
                  <div
                    className={[
                      "mt-1 h-2 w-2 shrink-0 rounded-full",
                      isUp
                        ? "bg-[var(--color-bull)]"
                        : "bg-[var(--color-bear)]",
                    ].join(" ")}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-sm font-semibold text-[var(--color-fg)]">
                      {p.provider}
                    </p>
                    <p className="text-[11px] text-[var(--color-fg-muted)]">
                      {p.status}
                      {p.latencyMs != null ? ` · ${p.latencyMs}ms` : ""}
                    </p>
                    {p.errorMessage && (
                      <p className="text-[11px] text-[var(--color-bear)]">
                        {p.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {status.providers.error && (
            <p className="text-[11px] text-[var(--color-warning)]">
              Provider health error: {status.providers.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
