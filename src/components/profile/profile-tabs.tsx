"use client";

import { Bell, KeyRound, Plug, UserCog } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Tab, TabList, TabPanel, Tabs } from "@/components/ui/tabs";

type ProfileTabId = "account" | "data-sources" | "api-keys" | "alerts";

const TAB_IDS: readonly ProfileTabId[] = ["account", "data-sources", "api-keys", "alerts"] as const;

function isTabId(value: string | null): value is ProfileTabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

interface ProfileTabsProps {
  account: ReactNode;
  dataSources: ReactNode;
  apiKeys: ReactNode;
  alerts: ReactNode;
  /**
   * URL hash fragment (without the `#`) used to deep-link to a specific tab
   * — `/profile#api-keys`, `/profile#alerts`, etc. Defaults to `account`.
   */
  defaultTab?: ProfileTabId;
}

/**
 * Client wrapper around the shared <Tabs> primitive that arranges the
 * profile page's four panels (Account, Data sources, API keys, Alerts).
 *
 * Server-rendered children for each panel are passed in as React nodes so
 * the heavy data fetching stays on the server while the tab-switching
 * interaction stays purely client-side. The active tab is reflected into
 * `location.hash` so deep-links and the browser back/forward buttons
 * navigate between sections without a full page reload.
 */
export function ProfileTabs({
  account,
  dataSources,
  apiKeys,
  alerts,
  defaultTab = "account",
}: ProfileTabsProps) {
  const [tab, setTab] = useState<ProfileTabId>(defaultTab);

  // Sync from the URL hash on mount and on back/forward navigation so a
  // user pasting `/profile#alerts` lands on the right tab.
  useEffect(() => {
    function syncFromHash() {
      const hash = typeof window !== "undefined"
        ? window.location.hash.replace(/^#/, "")
        : "";
      if (isTabId(hash)) setTab(hash);
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const onChange = useCallback((next: string) => {
    if (!isTabId(next)) return;
    setTab(next);
    if (typeof window !== "undefined") {
      // Use replaceState so tab swaps don't pollute browser history but
      // the hash still survives reload / share.
      const url = `${window.location.pathname}${window.location.search}#${next}`;
      window.history.replaceState(null, "", url);
    }
  }, []);

  return (
    <Tabs value={tab} onValueChange={onChange}>
      <TabList aria-label="Profile sections">
        <Tab value="account">
          <UserCog className="h-3.5 w-3.5" />
          Account
        </Tab>
        <Tab value="data-sources">
          <Plug className="h-3.5 w-3.5" />
          Data sources
        </Tab>
        <Tab value="api-keys">
          <KeyRound className="h-3.5 w-3.5" />
          API keys
        </Tab>
        <Tab value="alerts">
          <Bell className="h-3.5 w-3.5" />
          Alerts
        </Tab>
      </TabList>

      <TabPanel value="account">{account}</TabPanel>
      <TabPanel value="data-sources">{dataSources}</TabPanel>
      <TabPanel value="api-keys">{apiKeys}</TabPanel>
      <TabPanel value="alerts">{alerts}</TabPanel>
    </Tabs>
  );
}
