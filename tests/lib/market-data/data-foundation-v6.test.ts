/**
 * Data Foundation V6 — unit tests for the reusable fail-closed producer data
 * gate (§20/§21/§22) and the PROVENANCE_UNKNOWN legacy-provenance helpers (§26).
 *
 * These are PURE-logic tests over a fake Prisma (candleBar count/aggregate). The
 * REAL DB effects (daily normalization, gap re-detection, gating in producers)
 * are proven by the scripts/data-v4-daily-migration.ts + data-v6-daily-gap-
 * redetect.ts harnesses and the DB-verified counts in ALPHAFORGE_DATA_V6_*.
 */
import { describe, it, expect } from "vitest";

import {
  evaluateProducerDataGate,
  historyToAvailabilityStatus,
  filterInstrumentsByProducerGate,
} from "@/lib/market-data/services/producer-data-gate.service";
import {
  PROVENANCE_UNKNOWN,
  isProvenanceUnknown,
  hasVerifiedProvenance,
  datasetVersion,
} from "@/lib/market-data/dataset-version";

/** Fake Prisma exposing only what checkHistorySufficiency needs. */
function fakePrismaWithBars(barsBySymbol: Record<string, number>) {
  return {
    candleBar: {
      count: async (args: { where: { instrumentId: string } }) =>
        barsBySymbol[args.where.instrumentId] ?? 0,
      aggregate: async (args: { where: { instrumentId: string } }) => {
        const n = barsBySymbol[args.where.instrumentId] ?? 0;
        return n > 0
          ? { _min: { time: 1_700_000_000 }, _max: { time: 1_750_000_000 } }
          : { _min: { time: null }, _max: { time: null } };
      },
    },
  } as never;
}

describe("V6 producer data gate — fail-closed", () => {
  it("ALLOWS when persisted history meets the warm-up requirement", async () => {
    const prisma = fakePrismaWithBars({ RELIANCE: 500 });
    const res = await evaluateProducerDataGate({
      instrumentId: "RELIANCE",
      interval: "1d",
      requiredBars: 20,
      prisma,
    });
    expect(res.allowed).toBe(true);
    expect(res.status).toBe("AVAILABLE");
    expect(res.history.availableBars).toBe(500);
    expect(res.history.missingBars).toBe(0);
  });

  it("BLOCKS with INSUFFICIENT_HISTORY and reports required/available/missing", async () => {
    const prisma = fakePrismaWithBars({ NIFTY: 1 });
    const res = await evaluateProducerDataGate({
      instrumentId: "NIFTY",
      interval: "1d",
      requiredBars: 20,
      prisma,
    });
    expect(res.allowed).toBe(false);
    expect(res.status).toBe("INSUFFICIENT_HISTORY");
    expect(res.history.requiredBars).toBe(20);
    expect(res.history.availableBars).toBe(1);
    expect(res.history.missingBars).toBe(19);
    expect(res.reason).toContain("requires 20");
    expect(res.reason).toContain("missing 19");
  });

  it("BLOCKS (UNAVAILABLE) when there are zero persisted bars", async () => {
    const prisma = fakePrismaWithBars({});
    const res = await evaluateProducerDataGate({
      instrumentId: "UNKNOWNSYM",
      interval: "1d",
      requiredBars: 20,
      prisma,
    });
    expect(res.allowed).toBe(false);
    // 0 bars maps to INSUFFICIENT_HISTORY (a first-class status), which is a
    // hard veto (NON_TRADABLE) — never silently treated as available.
    expect(["INSUFFICIENT_HISTORY", "UNAVAILABLE"]).toContain(res.status);
  });

  it("fails CLOSED when the gate read itself throws", async () => {
    const throwingPrisma = {
      candleBar: {
        count: async () => {
          throw new Error("db down");
        },
        aggregate: async () => {
          throw new Error("db down");
        },
      },
    } as never;
    const res = await evaluateProducerDataGate({
      instrumentId: "RELIANCE",
      interval: "1d",
      requiredBars: 20,
      prisma: throwingPrisma,
    });
    expect(res.allowed).toBe(false);
    expect(res.status).toBe("UNAVAILABLE");
    expect(res.reason).toContain("fail-closed");
  });

  it("filterInstrumentsByProducerGate splits allowed vs blocked", async () => {
    const prisma = fakePrismaWithBars({ RELIANCE: 500, TCS: 500, NIFTY: 1 });
    const { allowed, blocked } = await filterInstrumentsByProducerGate(
      [{ instrumentId: "RELIANCE" }, { instrumentId: "TCS" }, { instrumentId: "NIFTY" }],
      { interval: "1d", requiredBars: 20, prisma },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    // NIFTY has only 1 bar → blocked; RELIANCE + TCS pass.
    expect(allowed.map((a: { instrumentId: string }) => a.instrumentId).sort()).toEqual(["RELIANCE", "TCS"]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].item.instrumentId).toBe("NIFTY");
  });

  it("historyToAvailabilityStatus preserves INSUFFICIENT_HISTORY as first-class", () => {
    expect(
      historyToAvailabilityStatus({
        status: "INSUFFICIENT_HISTORY",
        requiredBars: 200,
        availableBars: 10,
        missingBars: 190,
        firstTimestamp: null,
        lastTimestamp: null,
        reason: null,
      }),
    ).toBe("INSUFFICIENT_HISTORY");
  });
});

describe("V6 legacy provenance sentinel (§26)", () => {
  it("PROVENANCE_UNKNOWN is not a real provider and is detectable", () => {
    expect(PROVENANCE_UNKNOWN).toContain("provenance-unknown");
    expect(isProvenanceUnknown(PROVENANCE_UNKNOWN)).toBe(true);
    expect(isProvenanceUnknown(null)).toBe(false);
    expect(isProvenanceUnknown("2026-09-10.angel_one.norm-v3")).toBe(false);
  });

  it("hasVerifiedProvenance is false for null and the legacy sentinel, true for a real provider version", () => {
    expect(hasVerifiedProvenance(null)).toBe(false);
    expect(hasVerifiedProvenance(undefined)).toBe(false);
    expect(hasVerifiedProvenance(PROVENANCE_UNKNOWN)).toBe(false);
    expect(hasVerifiedProvenance(datasetVersion("2026-09-10", { kind: "provider", provider: "angel_one" }))).toBe(true);
  });
});
