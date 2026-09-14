import "server-only";
import { DEFAULT_SELECTIONS } from "./data-sources-shared";
import type { DataSelections } from "./data-sources-shared";

/**
 * Returns the active data selections — always data-service2.0.
 * Provider selection is no longer configurable after the data-service2.0
 * centralization refactor.
 */
export async function getActiveSelections(): Promise<DataSelections> {
  return DEFAULT_SELECTIONS;
}
