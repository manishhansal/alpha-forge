"use client";

import { usePathname } from "next/navigation";

export type Market = "crypto" | "india";

const INDIA_PREFIX = "/in";

/**
 * Source-of-truth for which market the user is currently looking at. We key
 * off the URL pathname so deep-linking always lands in the right mode and
 * the back/forward buttons "just work" — no extra persistence layer needed.
 */
export function marketFromPath(pathname: string | null | undefined): Market {
  if (!pathname) return "crypto";
  if (pathname === INDIA_PREFIX || pathname.startsWith(`${INDIA_PREFIX}/`)) {
    return "india";
  }
  return "crypto";
}

export function useActiveMarket(): Market {
  const pathname = usePathname();
  return marketFromPath(pathname);
}
