"use client";

/**
 * CommandPalette
 *
 * A full-screen command menu (⌘K / Ctrl+K) built on cmdk.
 * Groups:
 *   • Navigation   — all sidebar pages for the active market
 *   • India Charts — jump directly to any F&O index chart
 *   • F&O Symbols  — search the full 200+ F&O stock universe
 *   • Crypto       — BTC / ETH / SOL quick links
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "cmdk";
import {
  Activity,
  BarChart3,
  Beaker,
  Brain,
  Briefcase,
  CandlestickChart,
  Clock3,
  Eye,
  Flame,
  Gauge,
  History,
  Layers,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Radar,
  Sparkles,
  Trophy,
  TrendingUp,
  Bitcoin,
  Building2,
  Search,
} from "lucide-react";

import { useActiveMarket } from "@/lib/market-mode";
import { FNO_INDICES, FNO_STOCKS } from "@/lib/india/fno-symbols";

/* ── Static nav lists (mirrors sidebar.tsx) ─────────────────────────────── */

const INDIA_PAGES = [
  { href: "/in/dashboard",         label: "Overview",           icon: LayoutDashboard },
  { href: "/in/best-time",         label: "Best Time",          icon: Clock3 },
  { href: "/in/options",           label: "Options",            icon: Gauge },
  { href: "/in/signals",           label: "Signals",            icon: Sparkles },
  { href: "/in/ai-signals",        label: "AI Signals",         icon: Brain },
  { href: "/in/strategies",        label: "Strategies",         icon: Layers },
  { href: "/in/paper-trading",     label: "Paper Trading",      icon: Briefcase },
  { href: "/in/strategy-backtest", label: "Strategy Backtest",  icon: LineChart },
  { href: "/in/strategy-lab",      label: "Strategy Lab",       icon: Beaker },
  { href: "/in/heatmap",           label: "Heatmap",            icon: Flame },
  { href: "/in/daily-picks",       label: "Daily Picks",        icon: Trophy },
  { href: "/in/history",           label: "Trade History",      icon: History },
  { href: "/in/news",              label: "News",               icon: Newspaper },
  { href: "/in/scanner",           label: "Scanner",            icon: Radar },
  { href: "/in/watchlist",         label: "Watchlist",          icon: Eye },
  { href: "/in/options-workbench", label: "Options Workbench",  icon: TrendingUp },
];

const CRYPTO_PAGES = [
  { href: "/",                  label: "Overview",          icon: LayoutDashboard },
  { href: "/best-time",         label: "Best Time",         icon: Clock3 },
  { href: "/options",           label: "Options",           icon: Gauge },
  { href: "/signals",           label: "Signals",           icon: Sparkles },
  { href: "/ai-signals",        label: "AI Signals",        icon: Brain },
  { href: "/strategies",        label: "Strategies",        icon: Layers },
  { href: "/paper-trading",     label: "Paper Trading",     icon: Briefcase },
  { href: "/strategy-backtest", label: "Strategy Backtest", icon: LineChart },
  { href: "/strategy-lab",      label: "Strategy Lab",      icon: Beaker },
  { href: "/heatmap",           label: "Heatmap",           icon: Flame },
  { href: "/futures",           label: "Futures",           icon: CandlestickChart },
];

const CRYPTO_SYMBOLS = [
  { label: "Bitcoin (BTC)", href: "/", icon: Bitcoin },
  { label: "Ethereum (ETH)", href: "/",icon: Activity },
  { label: "Solana (SOL)", href: "/",  icon: Activity },
];

/* ── Context + hook ─────────────────────────────────────────────────────── */

interface CmdCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
}

const CommandPaletteContext = React.createContext<CmdCtx>({
  open: false,
  setOpen: () => {},
});

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // Global ⌘K / Ctrl+K shortcut
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <CommandPaletteContext.Provider value={{ open, setOpen }}>
      {children}
      <CommandPalette />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  return React.useContext(CommandPaletteContext);
}

/* ── Palette UI ─────────────────────────────────────────────────────────── */

function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  const market = useActiveMarket();
  const [query, setQuery] = React.useState("");

  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
  }, [setOpen]);

  const go = React.useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  // Slice the F&O stock list for performance — cmdk filters client-side
  // but 200+ items rendered at once is wasteful when query is empty.
  const stockItems = React.useMemo(() => {
    if (!query) return FNO_STOCKS.slice(0, 12);
    return FNO_STOCKS.filter((s) =>
      s.toLowerCase().includes(query.toLowerCase()),
    ).slice(0, 30);
  }, [query]);

  const pages = market === "india" ? INDIA_PAGES : CRYPTO_PAGES;

  if (!open) return null;

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={close}
    >
      <div
        className="w-full max-w-xl glass-strong rounded-2xl overflow-hidden shadow-2xl"
        style={{
          boxShadow:
            "0 0 0 1px var(--color-border-strong), 0 32px 80px -16px rgba(0,0,0,0.8), 0 0 48px -16px var(--glow-brand)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Command
          label="Command Menu"
          shouldFilter={false}
          className="flex flex-col"
        >
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-fg-subtle)]" />
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search pages, symbols, actions…"
              className="flex-1 bg-transparent text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] outline-none"
              autoFocus
            />
            <kbd className="hidden shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-subtle)] sm:block">
              ESC
            </kbd>
          </div>

          <CommandList className="max-h-[420px] overflow-y-auto p-2 [scrollbar-width:thin]">
            <CommandEmpty className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
              No results for &ldquo;{query}&rdquo;
            </CommandEmpty>

            {/* Navigation */}
            <CommandGroup
              heading={
                <span className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                  {market === "india" ? <Building2 className="h-3 w-3" /> : <Bitcoin className="h-3 w-3" />}
                  {market === "india" ? "India Market" : "Crypto"} — Pages
                </span>
              }
            >
              {pages
                .filter(
                  (p) =>
                    !query ||
                    p.label.toLowerCase().includes(query.toLowerCase()),
                )
                .map((p) => (
                  <PaletteItem
                    key={p.href}
                    icon={<p.icon className="h-4 w-4" />}
                    label={p.label}
                    onSelect={() => go(p.href)}
                  />
                ))}
            </CommandGroup>

            <CommandSeparator className="my-1 h-px bg-[var(--color-border)]" />

            {/* India chart shortcuts */}
            {market === "india" && (
              <>
                <CommandGroup
                  heading={
                    <span className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                      Index Charts
                    </span>
                  }
                >
                  {FNO_INDICES.filter(
                    (i) =>
                      !query ||
                      i.name.toLowerCase().includes(query.toLowerCase()) ||
                      i.underlying.toLowerCase().includes(query.toLowerCase()),
                  ).map((idx) => (
                    <PaletteItem
                      key={idx.symbol}
                      icon={<BarChart3 className="h-4 w-4" />}
                      label={idx.name}
                      sublabel={idx.underlying}
                      accent="brand"
                      onSelect={() => go(`/in/chart/${encodeURIComponent(idx.symbol)}`)}
                    />
                  ))}
                </CommandGroup>

                <CommandSeparator className="my-1 h-px bg-[var(--color-border)]" />

                {/* F&O Stock search */}
                <CommandGroup
                  heading={
                    <span className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                      F&amp;O Stocks — Chart
                      {!query && (
                        <span className="ml-1.5 font-normal normal-case text-[var(--color-fg-subtle)] tracking-normal">
                          (type to search all {FNO_STOCKS.length})
                        </span>
                      )}
                    </span>
                  }
                >
                  {stockItems.map((sym) => (
                    <PaletteItem
                      key={sym}
                      icon={<BarChart3 className="h-4 w-4" />}
                      label={sym}
                      sublabel="NSE F&O"
                      onSelect={() => go(`/in/chart/${encodeURIComponent(sym)}`)}
                    />
                  ))}
                </CommandGroup>

                <CommandSeparator className="my-1 h-px bg-[var(--color-border)]" />

                {/* Option chain shortcuts */}
                <CommandGroup
                  heading={
                    <span className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                      Option Chain
                    </span>
                  }
                >
                  {FNO_INDICES.filter(
                    (i) =>
                      !query ||
                      i.underlying.toLowerCase().includes(query.toLowerCase()),
                  ).map((idx) => (
                    <PaletteItem
                      key={`opt-${idx.underlying}`}
                      icon={<Gauge className="h-4 w-4" />}
                      label={idx.underlying}
                      sublabel="Option Chain"
                      accent="info"
                      onSelect={() =>
                        go(`/in/options?symbol=${encodeURIComponent(idx.underlying)}`)
                      }
                    />
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Crypto symbols */}
            {market === "crypto" && (
              <CommandGroup
                heading={
                  <span className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
                    Crypto
                  </span>
                }
              >
                {CRYPTO_SYMBOLS.filter(
                  (s) =>
                    !query ||
                    s.label.toLowerCase().includes(query.toLowerCase()),
                ).map((s) => (
                  <PaletteItem
                    key={s.label}
                    icon={<s.icon className="h-4 w-4" />}
                    label={s.label}
                    onSelect={() => go(s.href)}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-2">
            <div className="flex items-center gap-3 text-[10px] text-[var(--color-fg-subtle)]">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5">↵</kbd>
                open
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5">esc</kbd>
                close
              </span>
            </div>
            <span className="text-[10px] text-[var(--color-fg-subtle)]">Alphaforge</span>
          </div>
        </Command>
      </div>
    </div>
  );
}

/* ── Shared palette item ─────────────────────────────────────────────────── */

type AccentKey = "brand" | "info" | "none";

const ACCENT_CLS: Record<AccentKey, string> = {
  brand: "text-[var(--color-brand)]",
  info:  "text-[var(--color-info)]",
  none:  "text-[var(--color-fg-muted)]",
};

function PaletteItem({
  icon,
  label,
  sublabel,
  accent = "none",
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  accent?: AccentKey;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={label}
      onSelect={onSelect}
      className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm outline-none aria-selected:bg-[var(--color-surface-hover)] aria-selected:text-[var(--color-fg)] transition-colors"
    >
      <span className={`shrink-0 ${ACCENT_CLS[accent]}`}>{icon}</span>
      <span className="flex-1 truncate font-medium text-[var(--color-fg)]">
        {label}
      </span>
      {sublabel && (
        <span className="shrink-0 text-[11px] text-[var(--color-fg-subtle)]">
          {sublabel}
        </span>
      )}
    </CommandItem>
  );
}
