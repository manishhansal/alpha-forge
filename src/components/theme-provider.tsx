"use client";

import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** User's stored preference — "light", "dark", or "system". */
  theme: Theme;
  /** What's actually painted right now ("light" or "dark"). Useful for
   *  components that need to swap an asset (a chart palette, an icon, …)
   *  rather than relying on a CSS class. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined,
);

export const THEME_STORAGE_KEY = "crypto-desk-theme";

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  // Mirror to `data-theme` so non-React code (e.g. lightweight-charts) can
  // pick up the active theme without touching classList.
  root.setAttribute("data-theme", resolved);
}

// ─── External store ────────────────────────────────────────────────────────
//
// Theme state genuinely lives outside React: it's persisted to
// `localStorage`, and one of its inputs (the OS preference) is updated
// asynchronously by `matchMedia`. `useSyncExternalStore` is purpose-built
// for this kind of "React mirrors an outside system" pattern and lets us
// avoid the React-19 `react-hooks/set-state-in-effect` lint while keeping
// the API ergonomic.

type Subscriber = () => void;

const STORAGE_LISTENERS = new Set<Subscriber>();

function notify(): void {
  for (const fn of STORAGE_LISTENERS) fn();
}

function subscribe(onChange: Subscriber): () => void {
  STORAGE_LISTENERS.add(onChange);

  // Cross-tab sync — pick up theme changes from other tabs/windows.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) onChange();
  };
  // OS-preference change — only matters while the user is on "system",
  // but it's cheap to listen always and let `getSnapshot` decide what to
  // resolve to.
  const mql =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  mql?.addEventListener("change", onChange);

  return () => {
    STORAGE_LISTENERS.delete(onChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
    mql?.removeEventListener("change", onChange);
  };
}

function getThemeSnapshot(): Theme {
  return readStoredTheme() ?? "system";
}

function getServerThemeSnapshot(): Theme {
  // SSR: we don't know the user's preference yet. Default to "system" so
  // the very first render matches what the `THEME_INIT_SCRIPT` will paint.
  return "system";
}

function resolveTheme(t: Theme): ResolvedTheme {
  return t === "system" ? getSystemTheme() : t;
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

/**
 * Drives the entire dashboard's theme. Reads / writes `localStorage`, listens
 * for system-preference changes when the user has chosen "system", and
 * toggles a `.dark` class on `<html>` (plus `color-scheme` and `data-theme`)
 * so every CSS variable in `globals.css` instantly resolves to the right
 * palette without re-rendering any component tree.
 *
 * SSR fallback is hard-coded to `"system"` inside `getServerThemeSnapshot`
 * — matches what the `THEME_INIT_SCRIPT` does before hydration, which
 * keeps the first paint flicker-free even when `localStorage` has a stored
 * preference.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const theme = React.useSyncExternalStore(
    subscribe,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );

  // resolvedTheme uses the same subscription but folds in the OS preference
  // for "system". Computed inside getSnapshot so it stays in lockstep with
  // `theme` and the mql change events without an extra effect.
  const resolvedTheme = React.useSyncExternalStore(
    subscribe,
    () => resolveTheme(getThemeSnapshot()),
    () => "dark" as const,
  );

  // Keep the `<html>` class in sync with the resolved theme. This is the
  // single allowed place we touch the DOM — it's an effect because it's
  // synchronizing with an external system (the document), which is exactly
  // what effects are for and the React-19 purity rules permit.
  React.useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = React.useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* ignore storage quota / private mode */
    }
    notify();
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme() must be used inside a <ThemeProvider>");
  }
  return ctx;
}

/**
 * Inline script applied before React hydrates so the right `.dark` class is
 * already on `<html>` for the very first paint. Prevents the flash of
 * incorrect theme that would otherwise blink between server-rendered HTML
 * and client-resolved theme.
 *
 * Must stay in sync with `THEME_STORAGE_KEY` and the resolution logic above.
 */
export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var key = "${THEME_STORAGE_KEY}";
    var stored = null;
    try { stored = localStorage.getItem(key); } catch (_) {}
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    var isDark = theme === "dark" || (theme === "system" && prefersDark);
    var root = document.documentElement;
    if (isDark) root.classList.add("dark");
    root.style.colorScheme = isDark ? "dark" : "light";
    root.setAttribute("data-theme", isDark ? "dark" : "light");
  } catch (_) {
    // best-effort — ThemeProvider will fix it up after hydration
  }
})();
`;
