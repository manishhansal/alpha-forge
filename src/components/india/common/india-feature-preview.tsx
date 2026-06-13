"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { CheckCircle2, Construction, ExternalLink, Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface FeaturePreviewProps {
  /** Hero status. "live" = working today, "preview" = partial, "planned" = coming. */
  state: "live" | "preview" | "planned";
  /** Short pill label next to the title. */
  pillLabel: string;
  /** What the user sees on this page right now. */
  liveSummary: React.ReactNode;
  /** A list of bullet items describing the working pieces. */
  liveBullets: string[];
  /** Roadmap items still in progress, in priority order. */
  roadmap: { title: string; detail: string }[];
  /** Optional CTA links (e.g. "Open Scanner", "See Backtest on Crypto"). */
  links?: { href: string; label: string; external?: boolean }[];
  /** Slot for the live India data (scanner table, sector heatmap, etc.). */
  children?: React.ReactNode;
}

const STATE_TOKENS: Record<
  FeaturePreviewProps["state"],
  { badge: "bull" | "warning" | "info"; label: string; icon: typeof Sparkles }
> = {
  live: { badge: "bull", label: "Live for NSE F&O", icon: CheckCircle2 },
  preview: {
    badge: "warning",
    label: "Live preview",
    icon: Sparkles,
  },
  planned: { badge: "info", label: "On the roadmap", icon: Construction },
};

/**
 * Shared shell for India pages whose surface is a mix of "this works now"
 * + "this is coming". Keeps the messaging honest while still delivering
 * useful data via the `children` slot. The crypto sidebar parity is the
 * primary requirement; this shell makes the half-built India counterparts
 * useful and unambiguous instead of dumping the user on a 404.
 */
export function IndiaFeaturePreview({
  state,
  pillLabel,
  liveSummary,
  liveBullets,
  roadmap,
  links,
  children,
}: FeaturePreviewProps) {
  const tokens = STATE_TOKENS[state];
  const Icon = tokens.icon;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tokens.badge}>
              <Icon className="h-3 w-3" />
              {tokens.label}
            </Badge>
            <Badge variant="outline">{pillLabel}</Badge>
          </div>
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
            {liveSummary}
          </p>
          <ul className="mt-3 grid gap-1.5 text-[12px] text-[var(--color-fg-muted)] md:grid-cols-2">
            {liveBullets.map((b) => (
              <li key={b} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-bull)]" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          {links && links.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {links.map((l) =>
                l.external ? (
                  <a
                    key={l.href}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-1 text-[11px] font-medium text-[var(--color-fg)] hover:border-[var(--color-border-strong)]"
                  >
                    {l.label}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-1 text-[11px] font-medium text-[var(--color-fg)] hover:border-[var(--color-border-strong)]"
                  >
                    {l.label}
                  </Link>
                ),
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {children}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
            Roadmap
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col">
            {roadmap.map((r, i) => (
              <motion.li
                key={r.title}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.04, 0.3) }}
                className={cn(
                  "flex items-start gap-3 border-b border-[var(--color-border)] py-3 last:border-b-0",
                )}
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-surface-hover)] text-[11px] font-semibold text-[var(--color-fg-muted)]">
                  {i + 1}
                </span>
                <div>
                  <div className="text-sm font-semibold">{r.title}</div>
                  <p className="text-[12px] text-[var(--color-fg-muted)]">
                    {r.detail}
                  </p>
                </div>
              </motion.li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
