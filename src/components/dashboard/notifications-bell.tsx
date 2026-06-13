"use client";

import { Bell, CheckCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

interface NotificationApiItem {
  id: string;
  title: string;
  body: string;
  symbol: string | null;
  kind: string;
  readAt: string | null;
  createdAt: string;
  alertId: string | null;
}

interface NotificationsResponse {
  items: NotificationApiItem[];
  unread: number;
}

const POLL_MS = 30_000;

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationApiItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as NotificationsResponse;
      setItems(json.items);
      setUnread(json.unread);
    } catch {
      // swallow — bell is best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the initial fetch onto the next task so the eslint
    // `react-hooks/set-state-in-effect` rule sees state updates only via an
    // external-system callback (the timer), not a synchronous effect body.
    const initial = setTimeout(() => void fetchList(), 0);
    const id = setInterval(fetchList, POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [fetchList]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onToggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) void fetchList();
      return next;
    });
  }, [fetchList]);

  const onMarkAll = useCallback(async () => {
    setUnread(0);
    setItems((prev) => prev.map((i) => (i.readAt ? i : { ...i, readAt: new Date().toISOString() })));
    try {
      await fetch("/api/notifications", { method: "POST" });
    } catch {
      // best-effort; next poll reconciles
    }
  }, []);

  const onMarkOne = useCallback(async (id: string) => {
    setItems((prev) =>
      prev.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: new Date().toISOString() } : i)),
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    } catch {
      // best-effort
    }
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={onToggle}
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 grid min-h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--color-bear)] px-1 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-30 w-[380px] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_18px_48px_-16px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Notifications</p>
              <p className="text-[11px] text-[var(--color-fg-subtle)]">
                {unread > 0 ? `${unread} unread` : "All caught up"}
              </p>
            </div>
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={onMarkAll}>
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && items.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
                Loading…
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-[12px] text-[var(--color-fg-muted)]">
                No notifications yet. Alerts will appear here when they fire.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]">
                {items.map((n) => {
                  const unreadRow = !n.readAt;
                  return (
                    <li
                      key={n.id}
                      className={`flex items-start gap-3 px-4 py-3 text-[12px] ${
                        unreadRow
                          ? "bg-[color-mix(in_oklch,var(--color-info)_8%,transparent)]"
                          : ""
                      }`}
                    >
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          unreadRow ? "bg-[var(--color-info)]" : "bg-transparent"
                        }`}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-[var(--color-fg)]">{n.title}</p>
                        <p className="mt-0.5 text-[var(--color-fg-muted)]">{n.body}</p>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                          {new Date(n.createdAt).toLocaleString()}
                          {n.symbol ? ` · ${n.symbol}` : ""}
                        </p>
                      </div>
                      {unreadRow ? (
                        <button
                          type="button"
                          onClick={() => void onMarkOne(n.id)}
                          className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                        >
                          Mark read
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
