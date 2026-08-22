"use client";

import {
  Activity,
  BarChart3,
  Beaker,
  Brain,
  Briefcase,
  CandlestickChart,
  ChevronLeft,
  ChevronRight,
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
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useState, useCallback, useRef } from "react";

import { MarketSwitcher } from "@/components/dashboard/market-switcher";
import { cn } from "@/lib/utils";
import { marketFromPath, type Market } from "@/lib/market-mode";
import { indiaSourceFooter } from "@/features/settings/data-sources-shared";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  public?: boolean;
}

export const CRYPTO_NAV: NavItem[] = [
  { href: "/",                   label: "Overview",          icon: LayoutDashboard, public: true },
  { href: "/best-time",          label: "Best Time",         icon: Clock3 },
  { href: "/options",            label: "Options",           icon: Gauge },
  { href: "/signals",            label: "Signals",           icon: Sparkles },
  { href: "/ai-signals",         label: "AI Signals",        icon: Brain },
  { href: "/strategies",         label: "Strategies",        icon: Layers },
  { href: "/paper-trading",      label: "Paper Trading",     icon: Briefcase },
  { href: "/strategy-backtest",  label: "Strategy Backtest", icon: LineChart },
  { href: "/strategy-lab",       label: "Strategy Lab",      icon: Beaker },
  { href: "/heatmap",            label: "Heatmap",           icon: Flame, public: true },
  { href: "/futures",            label: "Futures",           icon: CandlestickChart },
];

export const INDIA_NAV: NavItem[] = [
  { href: "/in/dashboard",           label: "Overview",           icon: LayoutDashboard, public: true },
  { href: "/in/best-time",           label: "Best Time",          icon: Clock3 },
  { href: "/in/options",             label: "Options",            icon: Gauge },
  { href: "/in/signals",             label: "Signals",            icon: Sparkles },
  { href: "/in/ai-signals",          label: "AI Signals",         icon: Brain },
  { href: "/in/strategies",          label: "Strategies",         icon: Layers },
  { href: "/in/paper-trading",       label: "Paper Trading",      icon: Briefcase },
  { href: "/in/strategy-backtest",   label: "Strategy Backtest",  icon: LineChart },
  { href: "/in/strategy-lab",        label: "Strategy Lab",       icon: Beaker },
  { href: "/in/heatmap",             label: "Heatmap",            icon: Flame, public: true },
  { href: "/in/daily-picks",         label: "Daily Picks",        icon: Trophy },
  { href: "/in/history",             label: "Trade History",      icon: History },
  { href: "/in/news",                label: "News",               icon: Newspaper },
  { href: "/in/scanner",             label: "Scanner",            icon: Radar },
  { href: "/in/watchlist",           label: "Watchlist",          icon: Eye },
  { href: "/in/chart/RELIANCE",      label: "Chart",              icon: BarChart3 },
  { href: "/in/options-workbench",   label: "Options Workbench",  icon: TrendingUp },
];

function isItemActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  if (item.href === "/") return pathname === "/";
  if (item.href.startsWith("/in/chart/")) return pathname.startsWith("/in/chart");
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/* ── Brand header ─────────────────────────────────────────────────────── */
function BrandHeader({ market, collapsed }: { market: Market; collapsed: boolean }) {
  const href = market === "india" ? "/in/dashboard" : "/";
  const sub  = market === "india"
    ? "NSE · Futures · Options"
    : "Crypto · NSE F&O · Signals";

  return (
    <Link href={href} className="mb-5 flex items-center gap-3 px-1">
      {/* Logo mark — always visible */}
      <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand)] via-[oklch(0.70_0.20_200)] to-[var(--color-info)] shadow-lg">
        <Activity className="h-4.5 w-4.5 text-white" />
        {/* subtle inner glow ring */}
        <span className="absolute inset-0 rounded-xl ring-2 ring-white/10" />
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: "auto" }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-col leading-tight whitespace-nowrap">
              <span className="text-sm font-bold tracking-tight gradient-text-brand">
                Alphaforge
              </span>
              <span className="text-[9px] uppercase tracking-[0.20em] text-[var(--color-fg-subtle)]">
                {sub}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Link>
  );
}

/* ── Footer card ──────────────────────────────────────────────────────── */
function FooterCard({
  market,
  indiaSourceLabels = [],
  collapsed,
}: {
  market: Market;
  indiaSourceLabels?: string[];
  collapsed: boolean;
}) {
  if (collapsed) return null;

  let title: string;
  let sub: string;
  if (market === "india") {
    const info = indiaSourceFooter(indiaSourceLabels);
    title = info.title;
    sub   = info.sub;
  } else {
    title = "Markets stream live via Binance WS";
    sub   = "Public endpoint — no API key required";
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="mt-3 rounded-xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-bg-elevated)] p-3"
    >
      <p className="text-[11px] font-medium text-[var(--color-fg-muted)]">{title}</p>
      <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">{sub}</p>
    </motion.div>
  );
}

/* ── Nav item with tooltip fallback when collapsed ────────────────────── */
function NavLink({
  item,
  active,
  collapsed,
  animDelay,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  animDelay: number;
}) {
  const Icon = item.icon;
  const tooltipRef = useRef<HTMLSpanElement | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, delay: animDelay, ease: "easeOut" }}
      className="relative group"
    >
      <Link
        href={item.href}
        className={cn(
          "relative flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm transition-all duration-200",
          active
            ? "bg-gradient-to-r from-[color-mix(in_oklch,var(--color-brand)_12%,transparent)] to-transparent text-[var(--color-fg)]"
            : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]",
          collapsed && "justify-center px-2",
        )}
      >
        {/* Active indicator bar */}
        {active && (
          <motion.span
            layoutId="sidebar-active-bar"
            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-brand)]"
            style={{ boxShadow: "0 0 8px 1px var(--glow-brand)" }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
          />
        )}

        {/* Icon */}
        <Icon
          className={cn(
            "h-4 w-4 shrink-0 transition-colors duration-200",
            active
              ? "text-[var(--color-brand)]"
              : "text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]",
          )}
          style={active ? { filter: "drop-shadow(0 0 5px var(--glow-brand))" } : undefined}
        />

        {/* Label */}
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.span
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.18, ease: "easeInOut" }}
              className="overflow-hidden whitespace-nowrap font-medium text-sm"
            >
              {item.label}
            </motion.span>
          )}
        </AnimatePresence>
      </Link>

      {/* Tooltip in collapsed mode */}
      {collapsed && (
        <span
          ref={tooltipRef}
          className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-fg)] shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150"
        >
          {item.label}
          {/* arrow */}
          <span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-[var(--color-border)]" />
        </span>
      )}
    </motion.div>
  );
}

/* ── Sign-in nudge ────────────────────────────────────────────────────── */
function SignInNudge({ collapsed }: { collapsed: boolean }) {
  if (collapsed) return null;
  return (
    <Link
      href="/login"
      className="mt-2 block rounded-xl border border-dashed border-[var(--color-border)] bg-[color-mix(in_oklch,var(--color-brand)_4%,transparent)] px-3 py-3 text-[11px] leading-snug text-[var(--color-fg-muted)] transition-all hover:border-[var(--color-brand)] hover:text-[var(--color-fg)]"
    >
      <span className="block font-semibold text-[var(--color-fg)]">Sign in to unlock</span>
      <span className="mt-0.5 block">
        Signals · Scalper · Backtest · Strategy Lab · Options · Alerts.
      </span>
    </Link>
  );
}

/* ── Collapse toggle button ───────────────────────────────────────────── */
function CollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="absolute -right-3.5 top-14 z-30 grid h-7 w-7 place-items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] shadow-lg transition-all hover:border-[var(--color-brand)] hover:text-[var(--color-brand)] hover:shadow-[0_0_12px_var(--glow-brand)]"
    >
      {collapsed
        ? <ChevronRight className="h-3.5 w-3.5" />
        : <ChevronLeft  className="h-3.5 w-3.5" />
      }
    </button>
  );
}

/* ── Main Sidebar ─────────────────────────────────────────────────────── */
export interface SidebarProps {
  isAuthed: boolean;
  indiaSourceLabels?: string[];
}

export function Sidebar({ isAuthed, indiaSourceLabels }: SidebarProps) {
  const pathname = usePathname();
  const market   = marketFromPath(pathname);
  const fullNav  = market === "india" ? INDIA_NAV : CRYPTO_NAV;
  const nav      = isAuthed ? fullNav : fullNav.filter((i) => i.public);

  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  return (
    <motion.aside
      animate={{ width: collapsed ? 64 : 240 }}
      transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
      className="relative flex h-screen shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-4 overflow-hidden"
    >
      {/* Subtle side glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-[color-mix(in_oklch,var(--color-brand)_18%,transparent)] to-transparent"
      />

      <CollapseToggle collapsed={collapsed} onToggle={toggle} />

      {/* Brand */}
      <BrandHeader market={market} collapsed={collapsed} />

      {/* Market switcher — hide label content in collapsed mode via CSS */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <MarketSwitcher />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Divider */}
      <div className="my-2 separator-gradient" />

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden pr-0.5 [scrollbar-width:none]">
        {nav.map((item, i) => (
          <NavLink
            key={item.href}
            item={item}
            active={isItemActive(item, pathname)}
            collapsed={collapsed}
            animDelay={i * 0.03}
          />
        ))}
        {!isAuthed && <SignInNudge collapsed={collapsed} />}
      </nav>

      {/* Footer */}
      <AnimatePresence>
        {!collapsed && (
          <FooterCard
            market={market}
            indiaSourceLabels={indiaSourceLabels}
            collapsed={collapsed}
          />
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
