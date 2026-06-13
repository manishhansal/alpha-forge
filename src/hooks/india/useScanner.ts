"use client";

import { useIndiaScannerStore } from "@/store/india/scannerStore";
import type { ScannerResult, ScannerType } from "@/types/india/scanner";
import { getJson, useFetchPoll } from "./useFetchPoll";

/**
 * Loads (and periodically refreshes) the active Indian-market scanner result.
 * In-flight fetches are aborted when the scanner type changes — important
 * because the OI / PCR / IV scanners hit NSE and can take several seconds.
 */
export function useScanner(type: ScannerType, intervalMs = 30_000, limit = 25) {
  const setResult = useIndiaScannerStore((s) => s.setResult);
  const setLoading = useIndiaScannerStore((s) => s.setLoading);
  const setError = useIndiaScannerStore((s) => s.setError);

  useFetchPoll<ScannerResult>(
    async (signal) => {
      setLoading(type, true);
      try {
        const data = await getJson<ScannerResult>(
          `/api/in/scanner?type=${encodeURIComponent(type)}&limit=${limit}`,
          signal,
        );
        setError(type, null);
        return data;
      } finally {
        setLoading(type, false);
      }
    },
    (data) => setResult(type, data),
    {
      intervalMs,
      onError: (e: unknown) =>
        setError(type, (e as Error)?.message ?? "Failed"),
    },
    [type, limit],
  );
}
