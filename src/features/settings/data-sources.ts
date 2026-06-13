import "server-only";

import { Prisma } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";

import {
  DEFAULT_SELECTIONS,
  normalizeSelections,
  type DataSourceSelections,
} from "./data-sources-shared";

export {
  DATA_SOURCES,
  DATA_SOURCES_BY_ID,
  DEFAULT_SELECTIONS,
  INDIA_OI_SOURCES,
  dataSourcesFor,
  normalizeSelections,
  type Capability,
  type CryptoSelections,
  type DataSourceId,
  type DataSourceMeta,
  type DataSourceSelections,
  type IndiaSelections,
  type Market,
} from "./data-sources-shared";

/**
 * Load the user's saved data-source selections. Returns the package-wide
 * defaults when nothing is stored yet so first-time visitors still get a
 * working dashboard out of the box.
 */
export async function getDataSourceSelections(
  userId: string,
): Promise<DataSourceSelections> {
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { dataSourcesJson: true },
  });
  return normalizeSelections(row?.dataSourcesJson);
}

/**
 * Replace the user's data-source selections atomically. Input is normalized
 * first so a malformed payload can't poison the column.
 */
export async function saveDataSourceSelections(
  userId: string,
  next: DataSourceSelections,
): Promise<void> {
  const safe = normalizeSelections(next);
  const prisma = getPrisma();
  await prisma.userSetting.upsert({
    where: { userId },
    create: { userId, dataSourcesJson: safe as unknown as Prisma.InputJsonValue },
    update: { dataSourcesJson: safe as unknown as Prisma.InputJsonValue },
  });
}

/** Fast helper for non-authenticated server contexts (env-only fallback). */
export function defaultSelections(): DataSourceSelections {
  return {
    india: {
      selected: [...DEFAULT_SELECTIONS.india.selected],
      optionChain: DEFAULT_SELECTIONS.india.optionChain,
    },
    crypto: {
      selected: [...DEFAULT_SELECTIONS.crypto.selected],
      primary: DEFAULT_SELECTIONS.crypto.primary,
    },
  };
}
