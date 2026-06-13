"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { OptionsCurrency } from "@/types/market";

const CURRENCIES: OptionsCurrency[] = ["BTC", "ETH", "SOL"];

interface Props {
  active: OptionsCurrency;
}

export function CurrencyTabs({ active }: Props) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1">
      {CURRENCIES.map((c) => {
        const isActive = c === active;
        return (
          <Link
            key={c}
            href={`/options?currency=${c}`}
            scroll={false}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            {c}
          </Link>
        );
      })}
    </div>
  );
}
