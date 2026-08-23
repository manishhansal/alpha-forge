"use client";

import * as React from "react";

/**
 * Returns `true` when the viewport width is BELOW the given threshold (px).
 * Uses ResizeObserver on <html> so it responds to viewport changes without
 * listening to `window.resize` directly.
 *
 * Server-side (SSR): always returns `false` — components should handle the
 * hydration mismatch by not relying on this value for initial render state
 * that differs from the persisted Zustand state.
 */
export function useBreakpoint(threshold: number): boolean {
  const [below, setBelow] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < threshold;
  });

  React.useEffect(() => {
    const checkWidth = () => setBelow(window.innerWidth < threshold);

    // Initial check in case the state differs from SSR default
    checkWidth();

    const obs = new ResizeObserver(checkWidth);
    obs.observe(document.documentElement);
    return () => obs.disconnect();
  }, [threshold]);

  return below;
}
