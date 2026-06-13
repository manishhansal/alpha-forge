import "server-only";

import { auth } from "@/lib/auth";

import { getDataSourceSelections, defaultSelections } from "./data-sources";
import type { DataSourceSelections } from "./data-sources-shared";

/**
 * Resolve the current user's data-source selections for the active request.
 * Never throws and never redirects — anonymous or expired-session callers
 * silently get the package-wide defaults so unauthenticated SSR paths
 * (health checks, static demos) keep working.
 */
export async function getActiveSelections(): Promise<DataSourceSelections> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return defaultSelections();
    return await getDataSourceSelections(userId);
  } catch {
    return defaultSelections();
  }
}
