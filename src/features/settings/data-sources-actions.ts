"use server";

import { revalidatePath } from "next/cache";

import { requireUserId } from "@/features/auth/session";

import { saveDataSourceSelections } from "./data-sources";
import {
  DATA_SOURCES_BY_ID,
  INDIA_OI_SOURCES,
  dataSourcesFor,
  normalizeSelections,
  type DataSourceId,
} from "./data-sources-shared";

export interface DataSourcesActionResult {
  ok: boolean;
  error?: string;
}

function readSelected(formData: FormData, name: string): DataSourceId[] {
  const all = formData.getAll(name);
  const out: DataSourceId[] = [];
  for (const v of all) {
    if (typeof v !== "string") continue;
    const meta = DATA_SOURCES_BY_ID[v as DataSourceId];
    if (meta) out.push(meta.id);
  }
  return out;
}

export async function saveDataSourcesAction(
  _prev: DataSourcesActionResult | undefined,
  formData: FormData,
): Promise<DataSourcesActionResult> {
  const userId = await requireUserId();

  const indiaSelected = readSelected(formData, "india").filter(
    (id) => dataSourcesFor("india").some((m) => m.id === id),
  );
  const cryptoSelected = readSelected(formData, "crypto").filter(
    (id) => dataSourcesFor("crypto").some((m) => m.id === id),
  );

  const indiaOi = formData.get("indiaOptionChain");
  const cryptoPrimary = formData.get("cryptoPrimary");

  // We rely on `normalizeSelections` to enforce per-field invariants
  // (drop unknown ids, ensure a sensible default when a list is empty,
  // pin crypto.primary to a member of crypto.selected, …).
  const next = normalizeSelections({
    india: {
      selected: indiaSelected,
      optionChain:
        typeof indiaOi === "string" && (INDIA_OI_SOURCES as readonly string[]).includes(indiaOi)
          ? indiaOi
          : "nse",
    },
    crypto: {
      selected: cryptoSelected,
      primary: typeof cryptoPrimary === "string" ? cryptoPrimary : undefined,
    },
  });

  try {
    await saveDataSourceSelections(userId, next);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  revalidatePath("/settings");
  return { ok: true };
}
