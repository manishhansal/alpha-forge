"use client";

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
  Layers,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Radar,
  Sparkles,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { MarketSwitcher } from "@/components/dashboard/market-switcher";
import { cn } from "@/lib/utils";
import { marketFromPath, type Market } from "@/lib/market-mode";
import { indiaSourceFooter } from "@/features/settings/data-sources-shared";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * Item is shown to anonymous visitors as well as signed-in users. Only
   * the two "showroom" surfaces (Overview + Heatmap, per market) carry
   * this flag — the rest of the nav requires a session and is hidden from
   * unauthenticated users so the sidebar matches what they can actually
   * open. The auth gate in `src/lib/auth.ts` is the source of truth; this
   * flag just keeps the UI in sync.
   */
  public?: boolean;
}

// Both markets expose the same "core" surfaces — Overview, Best Time,
// Options, Signals, AI Signals, Strategies, Paper Trading, Strategy
// Backtest, Strategy Lab and Heatmap — so users get the exact same mental
// map when they flip the market switcher. Each item routes to a
// market-aware page (`/in/*` for India, root for crypto) so the data is
// always scoped to the active market.
//
// "Strategies" replaces the original "Scalper" surface: it owns the
// strategy picker, the live signal feed and the strategy reference card
// (i.e. everything needed to *configure* and *watch* the engine). The
// new "Paper Trading" surface inherits the open-positions + journal +
// per-strategy performance breakdown — the read-only outcome of every
// strategy fire — so users can audit results separately from picking
// strategies.
//
// Items that only make sense on one surface (Crypto Futures, the India
// F&O Scanner / Watchlist / Chart) are appended underneath. Account-
// level preferences (settings, data sources, API keys, alerts)
// intentionally live on the user-avatar dropdown in the topbar
// (`/profile`) so the sidebar stays focused on market surfaces.
export const CRYPTO_NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard, public: true },
  { href: "/best-time", label: "Best Time", icon: Clock3 },
  { href: "/options", label: "Options", icon: Gauge },
  { href: "/signals", label: "Signals", icon: Sparkles },
  { href: "/ai-signals", label: "AI Signals", icon: Brain },
  { href: "/strategies", label: "Strategies", icon: Layers },
  { href: "/paper-trading", label: "Paper Trading", icon: Briefcase },
  { href: "/strategy-backtest", label: "Strategy Backtest", icon: LineChart },
  { href: "/strategy-lab", label: "Strategy Lab", icon: Beaker },
  { href: "/heatmap", label: "Heatmap", icon: Flame, public: true },
  { href: "/futures", label: "Futures", icon: CandlestickChart },
];

export const INDIA_NAV: NavItem[] = [
  { href: "/in/dashboard", label: "Overview", icon: LayoutDashboard, public: true },
  { href: "/in/best-time", label: "Best Time", icon: Clock3 },
  { href: "/in/options", label: "Options", icon: Gauge },
  { href: "/in/signals", label: "Signals", icon: Sparkles },
  { href: "/in/ai-signals", label: "AI Signals", icon: Brain },
  { href: "/in/strategies", label: "Strategies", icon: Layers },
  { href: "/in/paper-trading", label: "Paper Trading", icon: Briefcase },
  { href: "/in/strategy-backtest", label: "Strategy Backtest", icon: LineChart },
  { href: "/in/strategy-lab", label: "Strategy Lab", icon: Beaker },
  { href: "/in/heatmap", label: "Heatmap", icon: Flame, public: true },
  { href: "/in/daily-picks", label: "Daily Picks", icon: Trophy },
  { href: "/in/news", label: "News", icon: Newspaper },
  { href: "/in/scanner", label: "Scanner", icon: Radar },
  { href: "/in/watchlist", label: "Watchlist", icon: Eye },
  { href: "/in/chart/RELIANCE", label: "Chart", icon: BarChart3 },
];

function isItemActive(item: NavItem, pathname: string | null): boolean {
  if (!pathname) return false;
  if (item.href === "/") return pathname === "/";
  // For the Indian chart link we want to highlight when on ANY /in/chart/*.
  if (item.href.startsWith("/in/chart/"))
    return pathname.startsWith("/in/chart");
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function BrandHeader({ market }: { market: Market }) {
  // Both market headers carry the same Alphaforge brand mark — the subtitle
  // is the only thing that swaps so the user gets a contextual cue about
  // which market surface they're inside without ever doubting that they're
  // still in the same app.
  if (market === "india") {
    return (
      <Link href="/in/dashboard" className="mb-6 flex items-center gap-2 px-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-info)] text-[var(--color-brand-foreground)]">
          <Activity className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Alphaforge</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            NSE · Futures · Options
          </span>
        </div>
      </Link>
    );
  }
  return (
    <Link href="/" className="mb-6 flex items-center gap-2 px-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-info)] text-[var(--color-brand-foreground)]">
        <Activity className="h-4 w-4" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight">Alphaforge</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
          Crypto · NSE F&amp;O · Signals
        </span>
      </div>
    </Link>
  );
}

function FooterCard({
  market,
  indiaSourceLabels = [],
}: {
  market: Market;
  indiaSourceLabels?: string[];
}) {
  if (market === "india") {
    const { title, sub } = indiaSourceFooter(indiaSourceLabels);
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <p className="text-[11px] font-medium text-[var(--color-fg-muted)]">
          {title}
        </p>
        <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">{sub}</p>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="text-[11px] font-medium text-[var(--color-fg-muted)]">
        Markets stream live via Binance WS
      </p>
      <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
        Public endpoint — no API key required
      </p>
    </div>
  );
}

interface SidebarProps {
  /**
   * Whether the request carries a valid session. Drives nav filtering so
   * anonymous visitors only see the two "showroom" surfaces (Overview +
   * Heatmap, per market) — everything else is hidden until they sign in.
   * The actual route protection lives in `src/lib/auth.ts` (the auth gate
   * issues the redirect); this flag just keeps the visible nav honest.
   */
  isAuthed: boolean;
  /**
   * Display labels for the user's active India quote-source chain (primary
   * first), computed server-side in the dashboard layout. Drives the footer
   * card so it reflects the real provenance (e.g. "Live data via Angel One
   * SmartAPI") instead of a hardcoded string.
   */
  indiaSourceLabels?: string[];
}

export function Sidebar({ isAuthed, indiaSourceLabels }: SidebarProps) {
  const pathname = usePathname();
  const market = marketFromPath(pathname);
  const fullNav = market === "india" ? INDIA_NAV : CRYPTO_NAV;
  const nav = isAuthed ? fullNav : fullNav.filter((item) => item.public);

  return (
    <aside className="flex h-screen w-[240px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-4">
      <BrandHeader market={market} />

      <MarketSwitcher />

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {nav.map(({ href, label, icon: Icon }) => {
          const active = isItemActive({ href, label, icon: Icon }, pathname);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-[var(--color-surface)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 transition-colors",
                  active
                    ? "text-[var(--color-brand)]"
                    : "text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg-muted)]",
                )}
              />
              <span className="font-medium">{label}</span>
            </Link>
          );
        })}

        {isAuthed ? null : (
          // Anonymous-state hint at the bottom of the visible nav so users
          // immediately understand why the sidebar feels "thin" — and how
          // to unlock the rest of it.
          <Link
            href="/login"
            className="mt-2 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 text-[11px] leading-snug text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]"
          >
            <span className="block font-semibold text-[var(--color-fg)]">
              Sign in to unlock
            </span>
            <span className="mt-0.5 block">
              Signals · Scalper · Backtest · Strategy Lab · Options · Alerts
              · Profile.
            </span>
          </Link>
        )}
      </nav>

      <FooterCard market={market} indiaSourceLabels={indiaSourceLabels} />
    </aside>
  );
}
