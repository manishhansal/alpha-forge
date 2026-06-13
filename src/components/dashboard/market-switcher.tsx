"use client";

import { motion } from "framer-motion";
import { Bitcoin, Building2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { useActiveMarket, type Market } from "@/lib/market-mode";

const OPTIONS: { id: Market; label: string; icon: typeof Bitcoin; href: string }[] = [
  { id: "crypto", label: "Crypto", icon: Bitcoin, href: "/" },
  { id: "india", label: "Indian Market", icon: Building2, href: "/in/dashboard" },
];

/**
 * Two-segment toggle that lives at the top of the sidebar and lets the user
 * pick which market the dashboard surface is rendering — crypto (BTC / ETH /
 * SOL) or Indian NSE F&O. Clicking a segment navigates to the landing page
 * of that market so the rest of the nav swaps in sync with the URL.
 */
export function MarketSwitcher() {
  const router = useRouter();
  const active = useActiveMarket();

  return (
    <div
      role="radiogroup"
      aria-label="Market"
      className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
    >
      {OPTIONS.map(({ id, label, icon: Icon, href }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              if (!selected) router.push(href);
            }}
            className={cn(
              "relative inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
              selected
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]",
            )}
          >
            {selected && (
              <motion.span
                layoutId="market-switcher-pill"
                aria-hidden
                className="absolute inset-0 rounded-md bg-[var(--color-bg-elevated)] shadow-sm border border-[var(--color-border-strong)]"
                transition={{ type: "spring", stiffness: 480, damping: 32 }}
              />
            )}
            <Icon className="relative z-10 h-3.5 w-3.5" />
            <span className="relative z-10">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
