"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

// ─── Filter tab types ─────────────────────────────────────────────────────────

export type FilterTabId = "all" | "high-confidence" | "high-winrate";

export interface FilterTab {
  id: FilterTabId;
  label: string;
}

export const DEFAULT_FILTER_TABS: FilterTab[] = [
  { id: "all", label: "All" },
  { id: "high-confidence", label: "Most Confidence" },
  { id: "high-winrate", label: "High Winrate" },
];

// ─── Pagination helpers ───────────────────────────────────────────────────────

function buildPageList(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, total, current, current - 1, current + 1]);
  const pages = [...set]
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);

  const out: Array<number | "…"> = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) out.push("…");
    out.push(pages[i]);
  }
  return out;
}

// ─── Hook: client-side pagination + filter state ──────────────────────────────

export interface UsePaginationFilterOptions<T> {
  /** Full unfiltered list of items. */
  items: T[];
  /** Number of items per page. Default: 10 */
  pageSize?: number;
  /**
   * Extract a confidence / strength score from each item (0–1 or 0–100).
   * Used by the "Most Confidence" filter to surface top items.
   */
  getConfidence?: (item: T) => number | null;
  /**
   * Extract a winrate from each item (0–1 or 0–100).
   * Used by the "High Winrate" filter to surface top items.
   */
  getWinrate?: (item: T) => number | null;
  /** Threshold for "high confidence" (defaults to 0.7 on a 0–1 scale). */
  confidenceThreshold?: number;
  /** Threshold for "high winrate" (defaults to 0.6 on a 0–1 scale). */
  winrateThreshold?: number;
  /** Custom filter tabs (defaults to the standard 3). */
  tabs?: FilterTab[];
}

export interface UsePaginationFilterResult<T> {
  /** Currently visible page of items (post filter + paginate). */
  pageItems: T[];
  /** Current active filter tab. */
  activeTab: FilterTabId;
  setActiveTab: (tab: FilterTabId) => void;
  /** Current page (1-based). */
  page: number;
  setPage: (p: number) => void;
  totalPages: number;
  /** Total items after filtering (before paginating). */
  filteredTotal: number;
  /** Total items before filtering. */
  total: number;
  pageSize: number;
  /** The filter tabs definition. */
  tabs: FilterTab[];
}

export function usePaginationFilter<T>(
  options: UsePaginationFilterOptions<T>,
): UsePaginationFilterResult<T> {
  const {
    items,
    pageSize = 10,
    getConfidence,
    getWinrate,
    confidenceThreshold = 0.7,
    winrateThreshold = 0.6,
    tabs = DEFAULT_FILTER_TABS,
  } = options;

  const [activeTab, setActiveTabRaw] = useState<FilterTabId>("all");
  const [page, setPageRaw] = useState(1);

  const setActiveTab = useCallback((tab: FilterTabId) => {
    setActiveTabRaw(tab);
    setPageRaw(1); // reset page on filter change
  }, []);

  const setPage = useCallback(
    (p: number) => {
      setPageRaw(Math.max(1, p));
    },
    [],
  );

  const filtered = useMemo(() => {
    if (activeTab === "all") return items;

    if (activeTab === "high-confidence" && getConfidence) {
      return items.filter((item) => {
        const c = getConfidence(item);
        if (c == null) return false;
        // Normalize: if max value in dataset > 1, treat it as 0–100 scale
        const normalized = c > 1 ? c / 100 : c;
        return normalized >= confidenceThreshold;
      });
    }

    if (activeTab === "high-winrate" && getWinrate) {
      return items.filter((item) => {
        const w = getWinrate(item);
        if (w == null) return false;
        const normalized = w > 1 ? w / 100 : w;
        return normalized >= winrateThreshold;
      });
    }

    // Fallback: if extractor not provided, show all
    return items;
  }, [items, activeTab, getConfidence, getWinrate, confidenceThreshold, winrateThreshold]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  // Clamp page if filter changed and current page is beyond the new total
  const clampedPage = Math.min(page, totalPages);
  if (clampedPage !== page) {
    // Schedule update for next tick to avoid set-state-in-render
    setTimeout(() => setPageRaw(clampedPage), 0);
  }

  const pageItems = useMemo(() => {
    const start = (clampedPage - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, clampedPage, pageSize]);

  return {
    pageItems,
    activeTab,
    setActiveTab,
    page: clampedPage,
    setPage,
    totalPages,
    filteredTotal: filtered.length,
    total: items.length,
    pageSize,
    tabs,
  };
}

// ─── UI Components ────────────────────────────────────────────────────────────

interface FilterTabsProps {
  tabs: FilterTab[];
  active: FilterTabId;
  onChange: (id: FilterTabId) => void;
  className?: string;
}

/**
 * Row of filter-tab chips (All / Most Confidence / High Winrate).
 */
export function FilterTabs({ tabs, active, onChange, className }: FilterTabsProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]/50 p-0.5",
        className,
      )}
      role="tablist"
      aria-label="Filter data"
    >
      {tabs.map((tab) => {
        const on = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap",
              on
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] shadow-sm ring-1 ring-inset ring-[var(--color-border-strong)]"
                : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

interface PaginationStripProps {
  page: number;
  totalPages: number;
  filteredTotal: number;
  pageSize: number;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (p: number) => void;
  className?: string;
}

/**
 * Pagination strip with prev/next + page number buttons.
 */
export function PaginationStrip({
  page,
  totalPages,
  filteredTotal,
  pageSize,
  disabled,
  onPrev,
  onNext,
  onJump,
  className,
}: PaginationStripProps) {
  const pages = useMemo(() => buildPageList(page, totalPages), [page, totalPages]);
  const prevDisabled = disabled || page <= 1;
  const nextDisabled = disabled || page >= totalPages;

  const pageStart = (page - 1) * pageSize;
  const pageEnd = Math.min(pageStart + pageSize, filteredTotal);

  if (totalPages <= 1) return null;

  return (
    <div className={cn("mt-3 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center", className)}>
      <p className="text-[11px] text-[var(--color-fg-muted)]">
        Showing{" "}
        <span className="font-medium text-[var(--color-fg)] tabular-nums">
          {filteredTotal === 0 ? 0 : pageStart + 1}–{pageEnd}
        </span>{" "}
        of <span className="font-medium text-[var(--color-fg)] tabular-nums">{filteredTotal}</span>
      </p>
      <nav aria-label="Pagination" className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={prevDisabled}
          aria-label="Previous page"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors",
            prevDisabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
          )}
        >
          <ChevronLeft className="h-3 w-3" />
          Prev
        </button>
        <div className="flex items-center gap-1">
          {pages.map((p, i) =>
            p === "…" ? (
              <span
                key={`ellipsis-${i}`}
                className="px-1.5 text-[11px] text-[var(--color-fg-subtle)]"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onJump(p)}
                disabled={disabled && p !== page}
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
                className={cn(
                  "h-7 min-w-7 rounded-md px-2 text-[11px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  p === page
                    ? "bg-[var(--color-surface)] text-[var(--color-fg)] ring-1 ring-inset ring-[var(--color-border-strong)]"
                    : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
                )}
              >
                {p}
              </button>
            ),
          )}
        </div>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          aria-label="Next page"
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors",
            nextDisabled
              ? "cursor-not-allowed opacity-40"
              : "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]",
          )}
        >
          Next
          <ChevronRight className="h-3 w-3" />
        </button>
      </nav>
    </div>
  );
}
