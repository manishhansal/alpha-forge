"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ALERT_CHANNELS,
  ALERT_TYPES,
  COMPARATORS,
  SYMBOLS,
  describeAlertType,
  describeComparator,
  thresholdUnit,
  type AlertChannel,
  type AlertType,
  type Comparator,
} from "@/features/alerts/types";

interface ApiAlert {
  id: string;
  symbol: string;
  type: string;
  threshold: number;
  comparator: string;
  channels: string[];
  webhookUrl: string | null;
  cooldownSec: number;
  active: boolean;
  triggeredAt: string | null;
  triggerCount: number;
}

interface FormState {
  symbol: (typeof SYMBOLS)[number];
  type: AlertType;
  threshold: string;
  comparator: Comparator;
  channels: AlertChannel[];
  webhookUrl: string;
  cooldownSec: string;
}

const DEFAULT_FORM: FormState = {
  symbol: "BTC",
  type: "PRICE_BREAKOUT",
  threshold: "",
  comparator: "gt",
  channels: ["IN_APP"],
  webhookUrl: "",
  cooldownSec: "900",
};

const PLACEHOLDER_BY_TYPE: Record<AlertType, string> = {
  FUNDING_SPIKE: "e.g. 50 (% APR)",
  OI_BREAKOUT: "e.g. 5 (% in 1h)",
  PRICE_BREAKOUT: "e.g. 100000 (USD)",
  LIQUIDATION_SURGE: "e.g. 50000000 (USD/5m)",
  SIGNAL_CHANGE: "(ignored)",
};

export function AlertsManager() {
  const [items, setItems] = useState<ApiAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [creating, setCreating] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { items: ApiAlert[] };
      setItems(json.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchList(), 0);
    return () => clearTimeout(t);
  }, [fetchList]);

  const toggleChannel = useCallback((ch: AlertChannel) => {
    setForm((f) => {
      const has = f.channels.includes(ch);
      const next = has ? f.channels.filter((c) => c !== ch) : [...f.channels, ch];
      return { ...f, channels: next.length > 0 ? next : f.channels };
    });
  }, []);

  const onCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setCreating(true);
      setError(null);
      try {
        const threshold = form.type === "SIGNAL_CHANGE" ? 0 : Number(form.threshold);
        if (form.type !== "SIGNAL_CHANGE" && !Number.isFinite(threshold)) {
          throw new Error("Threshold must be a number");
        }
        const body = {
          symbol: form.symbol,
          type: form.type,
          threshold,
          comparator: form.comparator,
          channels: form.channels,
          webhookUrl: form.channels.includes("WEBHOOK") ? form.webhookUrl : null,
          cooldownSec: Number(form.cooldownSec) || 900,
          active: true,
        };
        const res = await fetch("/api/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setForm(DEFAULT_FORM);
        await fetchList();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setCreating(false);
      }
    },
    [fetchList, form],
  );

  const onToggle = useCallback(
    async (alert: ApiAlert) => {
      setPendingId(alert.id);
      try {
        await fetch(`/api/alerts/${alert.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !alert.active }),
        });
        await fetchList();
      } finally {
        setPendingId(null);
      }
    },
    [fetchList],
  );

  const onDelete = useCallback(
    async (alert: ApiAlert) => {
      if (!confirm(`Delete alert for ${alert.symbol} ${alert.type}?`)) return;
      setPendingId(alert.id);
      try {
        await fetch(`/api/alerts/${alert.id}`, { method: "DELETE" });
        await fetchList();
      } finally {
        setPendingId(null);
      }
    },
    [fetchList],
  );

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={onCreate} className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
        <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          New alert
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alert-symbol">Symbol</Label>
            <select
              id="alert-symbol"
              value={form.symbol}
              onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value as FormState["symbol"] }))}
              className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:outline-none"
            >
              {SYMBOLS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alert-type">Type</Label>
            <select
              id="alert-type"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as AlertType }))}
              className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:outline-none"
            >
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>{describeAlertType(t)}</option>
              ))}
            </select>
          </div>

          {form.type !== "SIGNAL_CHANGE" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="alert-comparator">Comparator</Label>
                <select
                  id="alert-comparator"
                  value={form.comparator}
                  onChange={(e) => setForm((f) => ({ ...f, comparator: e.target.value as Comparator }))}
                  className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:outline-none"
                >
                  {COMPARATORS.map((c) => (
                    <option key={c} value={c}>
                      {describeComparator(c)} ({c})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="alert-threshold">Threshold ({thresholdUnit(form.type)})</Label>
                <Input
                  id="alert-threshold"
                  type="number"
                  step="any"
                  value={form.threshold}
                  onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))}
                  placeholder={PLACEHOLDER_BY_TYPE[form.type]}
                  required
                />
              </div>
            </>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alert-cooldown">Cooldown (sec)</Label>
            <Input
              id="alert-cooldown"
              type="number"
              min={30}
              max={86_400}
              value={form.cooldownSec}
              onChange={(e) => setForm((f) => ({ ...f, cooldownSec: e.target.value }))}
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label>Channels</Label>
            <div className="flex flex-wrap gap-2">
              {ALERT_CHANNELS.map((ch) => {
                const on = form.channels.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => toggleChannel(ch)}
                    className={`rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
                      on
                        ? "border-[var(--color-info)] bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)]"
                        : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    }`}
                  >
                    {ch.replace("_", " ").toLowerCase()}
                  </button>
                );
              })}
            </div>
          </div>

          {form.channels.includes("WEBHOOK") ? (
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="alert-webhook">Webhook URL</Label>
              <Input
                id="alert-webhook"
                type="url"
                value={form.webhookUrl}
                onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                placeholder="https://example.com/hook"
                required
              />
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end">
          <Button type="submit" disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creating ? "Creating…" : "Create alert"}
          </Button>
        </div>
      </form>

      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          Your alerts
        </p>
        {items === null ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">No alerts configured yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px]"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="font-semibold">{a.symbol}</span>
                  <Badge variant="outline">{describeAlertType(a.type as AlertType)}</Badge>
                  {a.type !== "SIGNAL_CHANGE" ? (
                    <span className="text-[var(--color-fg-muted)]">
                      {describeComparator(a.comparator as Comparator)} {a.threshold.toLocaleString()}
                      <span className="ml-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                        {thresholdUnit(a.type as AlertType)}
                      </span>
                    </span>
                  ) : null}
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                    {a.channels.join(" · ")}
                  </span>
                  {a.triggerCount > 0 ? (
                    <Badge variant="bull">×{a.triggerCount}</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void onToggle(a)}
                    disabled={pendingId === a.id}
                    className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.14em] transition-colors ${
                      a.active
                        ? "border-[var(--color-bull)] text-[var(--color-bull)]"
                        : "border-[var(--color-border)] text-[var(--color-fg-muted)]"
                    }`}
                  >
                    {a.active ? "Active" : "Paused"}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete alert"
                    disabled={pendingId === a.id}
                    onClick={() => void onDelete(a)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
