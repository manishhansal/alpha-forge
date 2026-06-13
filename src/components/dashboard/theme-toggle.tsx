"use client";

import { motion } from "framer-motion";
import { Monitor, Moon, Sun } from "lucide-react";
import * as React from "react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

interface ThemeOption {
  value: Theme;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

const OPTIONS: ThemeOption[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
];

/**
 * Three-segment pill toggle (Light / System / Dark) wired into
 * `useTheme()`. Lives in the topbar so it's identical across both the
 * crypto and Indian market surfaces.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="relative inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => setTheme(value)}
            className={cn(
              "relative inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors",
              active
                ? "text-[var(--color-fg)]"
                : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]",
            )}
          >
            {active && (
              <motion.span
                layoutId="theme-toggle-pill"
                aria-hidden
                className="absolute inset-0 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] shadow-sm"
                transition={{ type: "spring", stiffness: 500, damping: 32 }}
              />
            )}
            <Icon className="relative z-10 h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
