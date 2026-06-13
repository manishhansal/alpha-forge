"use client";

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight, accessible tabs primitive — no Radix dep. Controlled via
 * `value` + `onValueChange` to keep state ownership at the call site (so a
 * tab id can be persisted to localStorage / URL params without the
 * primitive caring).
 *
 * Composition:
 *   <Tabs value={...} onValueChange={...}>
 *     <TabList>
 *       <Tab value="a">A</Tab>
 *       <Tab value="b">B</Tab>
 *     </TabList>
 *     <TabPanel value="a">…</TabPanel>
 *     <TabPanel value="b">…</TabPanel>
 *   </Tabs>
 *
 * Inactive panels are kept in the DOM (`display: none`) by default so
 * polling / state inside them survives a tab switch — pass
 * `keepMounted={false}` on a panel to opt-out and unmount when hidden.
 */

interface TabsContextValue {
  value: string;
  onChange: (value: string) => void;
  baseId: string;
  registerTab: (value: string, el: HTMLButtonElement | null) => void;
  focusByOffset: (current: string, offset: 1 | -1) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsCtx(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs subcomponents must be used inside <Tabs>");
  return ctx;
}

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const baseId = useId();
  // Keep tab buttons in registration order so arrow-key navigation cycles
  // through the visually-rendered list rather than the iteration order of
  // a Map (which would be insertion order, but the registry survives
  // remounts).
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const orderRef = useRef<string[]>([]);

  const registerTab = useCallback((tabValue: string, el: HTMLButtonElement | null) => {
    if (!el) {
      tabsRef.current.delete(tabValue);
      orderRef.current = orderRef.current.filter((v) => v !== tabValue);
      return;
    }
    tabsRef.current.set(tabValue, el);
    if (!orderRef.current.includes(tabValue)) orderRef.current.push(tabValue);
  }, []);

  const focusByOffset = useCallback(
    (current: string, offset: 1 | -1) => {
      const order = orderRef.current;
      if (order.length === 0) return;
      const idx = order.indexOf(current);
      if (idx === -1) return;
      const next = order[(idx + offset + order.length) % order.length];
      const el = tabsRef.current.get(next);
      el?.focus();
      onValueChange(next);
    },
    [onValueChange],
  );

  const ctx = useMemo<TabsContextValue>(
    () => ({ value, onChange: onValueChange, baseId, registerTab, focusByOffset }),
    [value, onValueChange, baseId, registerTab, focusByOffset],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div className={cn("flex flex-col gap-4", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({
  children,
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset,0_8px_24px_-12px_rgba(0,0,0,0.6)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  children,
  className,
  disabled,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { value: active, onChange, baseId, registerTab, focusByOffset } = useTabsCtx();
  const isActive = value === active;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        focusByOffset(value, 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        focusByOffset(value, -1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusByOffset(value, -1);
      } else if (e.key === "End") {
        e.preventDefault();
        focusByOffset(value, 1);
      }
    },
    [value, focusByOffset],
  );

  return (
    <button
      type="button"
      role="tab"
      ref={(el) => registerTab(value, el)}
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      disabled={disabled}
      onClick={() => onChange(value)}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-medium tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-strong)]",
        isActive
          ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-info)_40%,transparent)]"
          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
  /** When false, the panel is unmounted while inactive. Defaults to true
   *  so internal polling / form state survives a tab switch. */
  keepMounted = true,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}) {
  const { value: active, baseId } = useTabsCtx();
  const isActive = value === active;
  if (!keepMounted && !isActive) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!isActive}
      className={cn(isActive ? "" : "hidden", className)}
    >
      {children}
    </div>
  );
}
