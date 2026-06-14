"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ExternalLink, Globe, Newspaper, TrendingDown, TrendingUp } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNews } from "@/hooks/india/useNews";
import { IndiaMarketSentimentBanner } from "./india-market-sentiment-banner";
import type {
  NewsCategory,
  NewsImpact,
  NewsItem,
  NewsSentimentLabel,
} from "@/types/india/news";

type CategoryFilter = "all" | NewsCategory;

const FILTERS: { id: CategoryFilter; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "all", label: "All", icon: Newspaper },
  { id: "india", label: "India F&O", icon: TrendingUp },
  { id: "global", label: "Global", icon: Globe },
];

const STORAGE_KEY = "india-news-active-category";

function loadCategory(): CategoryFilter {
  if (typeof window === "undefined") return "all";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "india" || raw === "global" || raw === "all") return raw;
  } catch {
    /* ignore */
  }
  return "all";
}

function impactChip(impact: NewsImpact): string {
  switch (impact) {
    case "high":
      return "bg-[color-mix(in_oklch,var(--color-brand)_18%,transparent)] text-[var(--color-brand)]";
    case "medium":
      return "bg-[color-mix(in_oklch,var(--color-info)_15%,transparent)] text-[var(--color-info)]";
    default:
      return "bg-[var(--color-surface-hover)] text-[var(--color-fg-subtle)]";
  }
}

function sentimentTone(label: NewsSentimentLabel): string {
  if (label === "bullish") return "text-[var(--color-bull)]";
  if (label === "bearish") return "text-[var(--color-bear)]";
  return "text-[var(--color-fg-muted)]";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMin = Math.round((Date.now() - t) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function NewsCard({ item, index }: { item: NewsItem; index: number }) {
  const SentimentIcon =
    item.sentiment.label === "bullish"
      ? TrendingUp
      : item.sentiment.label === "bearish"
        ? TrendingDown
        : Newspaper;
  return (
    <motion.a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.3) }}
      className="group flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-border-strong)]"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium leading-snug text-[var(--color-fg)] group-hover:text-[var(--color-brand)]">
          {item.title}
        </h3>
        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
      </div>

      {item.summary && (
        <p className="line-clamp-2 text-xs text-[var(--color-fg-muted)]">
          {item.summary}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${impactChip(item.impact)}`}
        >
          {item.impact} impact
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] font-semibold ${sentimentTone(item.sentiment.label)}`}
        >
          <SentimentIcon className="h-3 w-3" />
          {item.sentiment.label}
        </span>
        {item.symbols.slice(0, 4).map((s) => (
          <span
            key={s}
            className="rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg)]"
          >
            {s}
          </span>
        ))}
        {item.sectors.slice(0, 2).map((s) => (
          <span
            key={s}
            className="rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]"
          >
            {s}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between text-[10px] text-[var(--color-fg-subtle)]">
        <span>{item.source}</span>
        <span>{relativeTime(item.publishedAt)}</span>
      </div>
    </motion.a>
  );
}

export function IndiaNewsFeed() {
  const [category, setCategory] = React.useState<CategoryFilter>(() => loadCategory());

  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, category);
    } catch {
      /* ignore */
    }
  }, [category]);

  const { data, loading, error } = useNews(category);

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <IndiaMarketSentimentBanner sentiment={data?.sentiment ?? null} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
              Top market news
            </CardTitle>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => {
                const Icon = f.icon;
                const on = category === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setCategory(f.id)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ${
                      on
                        ? "bg-[var(--color-surface-hover)] text-[var(--color-fg)] ring-[var(--color-border-strong)]"
                        : "bg-transparent text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]"
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="py-2 text-sm text-[var(--color-bear)]">
              Couldn&apos;t load news: {error}
            </p>
          )}
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">
              {loading ? "Loading headlines…" : "No market-moving headlines right now."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {items.map((item, i) => (
                <NewsCard key={item.id} item={item} index={i} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
