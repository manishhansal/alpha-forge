"use client";

import { Search } from "lucide-react";
import { useCommandPalette } from "@/components/dashboard/command-palette";

/**
 * TopbarSearch — clickable search trigger that opens the command palette.
 * Extracted as a client component so the parent Topbar stays a Server Component.
 */
export function TopbarSearch() {
  const { setOpen } = useCommandPalette();

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette (⌘K)"
      className="relative flex h-8 w-[280px] items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-left text-[13px] text-[var(--color-fg-subtle)] transition-all hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-brand)] focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-brand)_12%,transparent)]"
    >
      <Search className="mr-2.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
      <span className="flex-1 truncate">Search symbol, signal, alert…</span>
      <kbd className="ml-2 hidden shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] leading-none sm:block">
        ⌘K
      </kbd>
    </button>
  );
}
