"use client";

import { Activity, BookOpen, Briefcase } from "lucide-react";
import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useJournalData } from "@/components/scalper/journal-data-context";
import { useStrategyFilter } from "@/components/scalper/strategy-context";
import { Badge } from "@/components/ui/badge";
import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";

const STORAGE_KEY = "scalper:active-tab:v1";

const TAB_IDS = ["signals", "positions", "journal"] as const;
type TabId = (typeof TAB_IDS)[number];
const DEFAULT_TAB: TabId = "signals";

function isTabId(v: string): v is TabId {
  return (TAB_IDS as ReadonlyArray<string>).includes(v);
}

// ── localStorage-backed external store for the active tab ──────────────
// Following the same `useSyncExternalStore` pattern as `strategy-context`,
// this lets us read the persisted tab synchronously (no hydration effect)
// and keep multiple tab controllers in sync if they ever co-exist.

const tabListeners = new Set<() => void>();
function subscribeTab(listener: () => void): () => void {
  tabListeners.add(listener);
  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    tabListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

function getClientTabSnapshot(): TabId {
  if (typeof window === "undefined") return DEFAULT_TAB;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && isTabId(raw)) return raw;
  } catch {
    // fall through to default
  }
  return DEFAULT_TAB;
}

function getServerTabSnapshot(): TabId {
  return DEFAULT_TAB;
}

function persistTab(value: TabId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore — non-fatal
  }
  tabListeners.forEach((l) => l());
}

interface Props {
  signalsTab: ReactNode;
  positionsTab: ReactNode;
  journalTab: ReactNode;
}

/**
 * Top-level tab controller for the Scalper page. Three tabs:
 *
 *   1. Strategies & signals — picker + live signal feed + how-it-works.
 *   2. Open positions       — live MTM positions table.
 *   3. Journal & performance — trade history + per-strategy / per-symbol
 *                              performance breakdown.
 *
 * The active tab id is persisted to localStorage so a reload lands on
 * the same tab the user was last looking at.
 *
 * All three panels stay mounted (`keepMounted`) so the journal data
 * provider keeps polling in the background regardless of which tab is
 * visible — switching back never shows stale data.
 */
export function ScalperTabs({ signalsTab, positionsTab, journalTab }: Props) {
  const active = useSyncExternalStore(
    subscribeTab,
    getClientTabSnapshot,
    getServerTabSnapshot,
  );

  const onChange = useCallback((value: string) => {
    if (!isTabId(value)) return;
    persistTab(value);
  }, []);

  // Live count of open positions for the badge on the Positions tab.
  const { open } = useJournalData();
  const { selected, timeframesFor } = useStrategyFilter();
  const openCount = useMemo(
    () =>
      open.filter(
        (t) =>
          selected.has(t.strategyId) && timeframesFor(t.strategyId).has(t.strategyTimeframe),
      ).length,
    [open, selected, timeframesFor],
  );

  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabList aria-label="Scalper sections">
        <Tab value="signals">
          <Activity className="h-3.5 w-3.5" />
          Strategies &amp; signals
        </Tab>
        <Tab value="positions">
          <Briefcase className="h-3.5 w-3.5" />
          Open positions
          {openCount > 0 ? (
            <Badge variant="info" className="ml-1 px-1.5 py-0 text-[10px]">
              {openCount}
            </Badge>
          ) : null}
        </Tab>
        <Tab value="journal">
          <BookOpen className="h-3.5 w-3.5" />
          Journal &amp; performance
        </Tab>
      </TabList>

      <TabPanel value="signals">
        <div className="flex flex-col gap-4">{signalsTab}</div>
      </TabPanel>
      <TabPanel value="positions">
        <div className="flex flex-col gap-4">{positionsTab}</div>
      </TabPanel>
      <TabPanel value="journal">
        <div className="flex flex-col gap-4">{journalTab}</div>
      </TabPanel>
    </Tabs>
  );
}
