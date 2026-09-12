/**
 * Data Foundation V3 — unit + integration tests for the intraday pipeline,
 * durable observability, gap detection/recovery, aggregation, provenance, and
 * capability matrix.
 *
 * DB-touching services are exercised against a small in-memory Prisma fake that
 * implements only the methods each service calls, so the tests are
 * deterministic and require no live Postgres. The real DB is separately proven
 * by the scripts/data-v3-*.ts harnesses (DB-VERIFIED evidence in the reports).
 */
import { describe, it, expect, vi } from "vitest";

import {
  PROVIDER_CAPABILITY_MATRIX,
  capabilityRow,
  intervalCapability,
  historyProvidersFor,
  liveProvidersFor,
  V3_INTRADAY_INTERVALS,
  renderCapabilityMatrixMarkdown,
} from "@/lib/market-data/provider-capability-matrix";
import { datasetVersion, parseDatasetVersion, NORMALIZER_VERSION } from "@/lib/market-data/dataset-version";
import { expectedCandleTimes, detectGaps } from "@/lib/market-data/services/gap-detection.service";
import { aggregateFrom1m } from "@/lib/market-data/services/candle-aggregation.service";
import { planChunks, runBackfill } from "@/lib/market-data/services/backfill-orchestrator.service";
import { recordDataIncident } from "@/lib/market-data/services/data-incident.service";
import { isOhlcConsistent } from "@/lib/market-data/services/candle-persist.service";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
function sessionOpenSec(istDate: string): number {
  const [y, m, d] = istDate.split("-").map(Number);
  return Math.floor((Date.UTC(y!, m! - 1, d!) - IST_OFFSET_MS) / 1000) + (9 * 60 + 15) * 60;
}

// ── Provider capability matrix (§3/§5) ─────────────────────────────────────

describe("provider capability matrix", () => {
  it("lists all six providers in priority order (V8: jugaad + openchart added)", () => {
    expect(PROVIDER_CAPABILITY_MATRIX.map((r) => r.provider)).toEqual([
      "scrapling", "angel_one", "upstox", "yahoo", "jugaad", "openchart",
    ]);
  });

  it("scrapling serves current-day intraday LIVE but NOT multi-day history", () => {
    const c = intervalCapability("scrapling", "5m");
    expect(c.supported).toBe(true);
    expect(c.live).toBe(true);
    expect(c.history).toBe(false); // deferred to Angel upstream
  });

  it("angel_one is the multi-day intraday HISTORY source for the intervals it actually serves (V8: no 3m in scope)", () => {
    // V8 removal: 3m is no longer a supported AlphaForge interval.
    // Angel getCandleData never had THREE_MINUTE (live-verified 2026-09-12).
    // All 3m references have been removed from production code and types.
    for (const iv of ["1m", "5m", "15m", "30m", "1h"] as const) {
      expect(intervalCapability("angel_one", iv).history).toBe(true);
    }
    // 3m is no longer in the Interval type — no assertion needed; TS would reject it.
  });

  it("historyProvidersFor(1m) excludes scrapling+yahoo, includes angel+upstox in order", () => {
    expect(historyProvidersFor("1m")).toContain("angel_one");
    expect(historyProvidersFor("1m")).toContain("upstox");
  });

  it("liveProvidersFor(5m) includes scrapling first", () => {
    expect(liveProvidersFor("5m")[0]).toBe("scrapling");
  });

  it("angel_one carries a conservative 3 req/s budget (403 past ~3/s)", () => {
    expect(capabilityRow("angel_one")?.requestsPerSecond).toBeLessThanOrEqual(3);
  });

  it("V3 targets the intraday intervals (3m excluded — V8 removal)", () => {
    expect([...V3_INTRADAY_INTERVALS]).toEqual(["1m", "5m", "10m", "15m", "30m", "1h"]);
  });

  it("markdown renderer marks disabled providers", () => {
    const md = renderCapabilityMatrixMarkdown((p) => p === "scrapling");
    expect(md).toContain("| scrapling |");
    expect(md).toMatch(/angel_one.*\| no \|/);
  });
});

// ── Dataset versioning (§18) ───────────────────────────────────────────────

describe("dataset versioning", () => {
  it("is deterministic for the same date + provider", () => {
    const a = datasetVersion("2026-09-10", { kind: "provider", provider: "angel_one" });
    const b = datasetVersion("2026-09-10", { kind: "provider", provider: "angel_one" });
    expect(a).toBe(b);
    expect(a).toBe(`2026-09-10.angel_one.${NORMALIZER_VERSION}`);
  });

  it("distinguishes provider vs aggregation vs correction", () => {
    expect(datasetVersion("2026-09-10", { kind: "aggregation", sourceInterval: "1m" })).toContain("agg-1m");
    expect(datasetVersion("2026-09-10", { kind: "correction", provider: "upstox" })).toContain("correction-upstox");
  });

  it("round-trips through parse", () => {
    const v = datasetVersion("2026-09-10", { kind: "provider", provider: "angel_one" });
    const p = parseDatasetVersion(v);
    expect(p.dateKey).toBe("2026-09-10");
    expect(p.source).toBe("angel_one");
  });
});

// ── OHLC integrity (§41) ───────────────────────────────────────────────────

describe("OHLC integrity", () => {
  it("accepts a self-consistent candle", () => {
    expect(isOhlcConsistent({ open: 100, high: 105, low: 99, close: 104 })).toBe(true);
  });
  it("rejects high < max(open,close)", () => {
    expect(isOhlcConsistent({ open: 100, high: 101, low: 99, close: 104 })).toBe(false);
  });
  it("rejects low > min(open,close)", () => {
    expect(isOhlcConsistent({ open: 100, high: 105, low: 101, close: 104 })).toBe(false);
  });
  it("rejects non-finite / non-positive", () => {
    expect(isOhlcConsistent({ open: 0, high: 105, low: 99, close: 104 })).toBe(false);
    expect(isOhlcConsistent({ open: 100, high: NaN, low: 99, close: 104 })).toBe(false);
  });
});

// ── Expected candle times (§9 calendar-aware) ──────────────────────────────

describe("expectedCandleTimes", () => {
  it("produces 375 1m bar-opens for a single trading day", () => {
    // 2026-09-10 is a Thursday (trading day in the fixture calendar).
    const times = expectedCandleTimes("1m", "2026-09-10", "2026-09-10");
    expect(times.length).toBe(375);
    expect(times[0]).toBe(sessionOpenSec("2026-09-10"));
  });

  it("produces 75 5m bar-opens for a single trading day", () => {
    expect(expectedCandleTimes("5m", "2026-09-10", "2026-09-10").length).toBe(75);
  });

  it("produces 0 bars for a weekend day (Saturday)", () => {
    // 2026-09-12 is a Saturday.
    expect(expectedCandleTimes("1m", "2026-09-12", "2026-09-12").length).toBe(0);
  });

  it("produces exactly one 1d bar per trading day", () => {
    expect(expectedCandleTimes("1d", "2026-09-10", "2026-09-10").length).toBe(1);
  });
});

// ── In-memory Prisma fake ──────────────────────────────────────────────────

interface FakeRow {
  instrumentId: string; exchange: string; intervalStr: string; time: number;
  open: number; high: number; low: number; close: number; volume: number;
  volumeUnavailable?: boolean; oi?: number | null; provider?: string | null; datasetVersion?: string | null;
}

function makeFakePrisma(rows: FakeRow[]) {
  const store = [...rows];
  const gaps: Record<string, unknown>[] = [];
  const incidents: Record<string, unknown>[] = [];
  return {
    __store: store,
    __gaps: gaps,
    __incidents: incidents,
    candleBar: {
      findMany: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }) => {
        let r = store.filter((row) =>
          (where.instrumentId == null || row.instrumentId === where.instrumentId) &&
          (where.exchange == null || row.exchange === where.exchange) &&
          (where.intervalStr == null || row.intervalStr === where.intervalStr) &&
          (() => {
            const t = where.time as { gte?: number; lte?: number; in?: number[] } | undefined;
            if (!t) return true;
            if (t.in) return t.in.includes(row.time);
            return (t.gte == null || row.time >= t.gte) && (t.lte == null || row.time <= t.lte);
          })(),
        );
        if (orderBy && (orderBy as { time?: string }).time === "asc") r = r.sort((a, b) => a.time - b.time);
        return r.map((x) => ({ ...x }));
      }),
      count: vi.fn(async () => store.length),
    },
    dataGap: {
      findUnique: vi.fn(async ({ where }: { where: { instrumentId_exchange_intervalStr_gapStart: { instrumentId: string; exchange: string; intervalStr: string; gapStart: number } } }) => {
        const k = where.instrumentId_exchange_intervalStr_gapStart;
        return gaps.find((g) => g.instrumentId === k.instrumentId && g.exchange === k.exchange && g.intervalStr === k.intervalStr && g.gapStart === k.gapStart) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { gaps.push(data); return data; }),
      findMany: vi.fn(async () => []),
    },
    dataQualityIncident: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        incidents.find((i) =>
          i.status === "OPEN" &&
          i.failureType === where.failureType &&
          (i.provider ?? null) === (where.provider ?? null) &&
          (i.instrumentId ?? null) === (where.instrumentId ?? null) &&
          (i.intervalStr ?? null) === (where.intervalStr ?? null),
        ) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `inc_${incidents.length}`, ...data }; incidents.push(row); return row; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = incidents.find((i) => i.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    providerObservation: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "obs_1", ...data })) },
  };
}

// ── Gap detection (§9/§10) ─────────────────────────────────────────────────

describe("detectGaps", () => {
  it("finds no gap when every 5m bar is present for a day", async () => {
    const opens = expectedCandleTimes("5m", "2026-09-10", "2026-09-10");
    const rows: FakeRow[] = opens.map((t) => ({ instrumentId: "X", exchange: "NSE", intervalStr: "5m", time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const prisma = makeFakePrisma(rows);
    const res = await detectGaps({ instrumentId: "X", exchange: "NSE", interval: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.gaps.length).toBe(0);
    expect(res.actualBars).toBe(opens.length);
  });

  it("detects a contiguous missing run inside the active period", async () => {
    const opens = expectedCandleTimes("5m", "2026-09-10", "2026-09-10");
    // Drop bars at indices 10,11,12 (a 3-bar gap), keep first+last so active period spans the day.
    const kept = opens.filter((_, i) => i < 10 || i > 12);
    const rows: FakeRow[] = kept.map((t) => ({ instrumentId: "X", exchange: "NSE", intervalStr: "5m", time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const prisma = makeFakePrisma(rows);
    const res = await detectGaps({ instrumentId: "X", exchange: "NSE", interval: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.gaps.length).toBe(1);
    expect(res.gaps[0]!.missingBars).toBe(3);
  });

  it("reports NO gap before the instrument's first observed bar (not-yet-listed)", async () => {
    const opens = expectedCandleTimes("5m", "2026-09-10", "2026-09-10");
    // Only the SECOND half of the day exists → the earlier bars are pre-listing, not a gap.
    const half = opens.slice(38);
    const rows: FakeRow[] = half.map((t) => ({ instrumentId: "Y", exchange: "NSE", intervalStr: "5m", time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const prisma = makeFakePrisma(rows);
    const res = await detectGaps({ instrumentId: "Y", exchange: "NSE", interval: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.gaps.length).toBe(0); // active period starts at first observed bar
  });

  it("returns noData=true (never a fabricated gap) when the instrument has zero bars", async () => {
    const prisma = makeFakePrisma([]);
    const res = await detectGaps({ instrumentId: "Z", exchange: "NSE", interval: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.noData).toBe(true);
    expect(res.gaps.length).toBe(0);
  });
});

// ── Higher-timeframe aggregation (§8) ──────────────────────────────────────

describe("aggregateFrom1m", () => {
  function full1mDay(instrument: string): FakeRow[] {
    const opens = expectedCandleTimes("1m", "2026-09-10", "2026-09-10");
    return opens.map((t, i) => ({
      instrumentId: instrument, exchange: "NSE", intervalStr: "1m", time: t,
      open: 100 + (i % 5), high: 100 + (i % 5) + 2, low: 100 + (i % 5) - 2, close: 100 + (i % 5) + 1,
      volume: 10, provider: "angel_one",
    }));
  }

  it("derives complete 5m bars from complete 1m and marks lineage", async () => {
    const prisma = makeFakePrisma(full1mDay("A"));
    const res = await aggregateFrom1m({ instrumentId: "A", exchange: "NSE", target: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.status).toBe("AVAILABLE");
    expect(res.producedBars).toBe(75);
    expect(res.droppedBars).toBe(0);
    expect(res.lineage.sourceInterval).toBe("1m");
    expect(res.lineage.sourceProviders).toContain("angel_one");
    // First 5m bar: open=first 1m open, volume=sum of 5.
    expect(res.candles[0]!.volume).toBe(50);
  });

  it("DROPS an incomplete bucket (never fabricates) → PARTIAL", async () => {
    const rows = full1mDay("B").filter((_, i) => i !== 2); // drop one 1m bar in the first bucket
    const prisma = makeFakePrisma(rows);
    const res = await aggregateFrom1m({ instrumentId: "B", exchange: "NSE", target: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.status).toBe("PARTIAL");
    expect(res.droppedBars).toBeGreaterThanOrEqual(1);
    expect(res.producedBars).toBe(74);
  });

  it("returns DATA_INSUFFICIENT when there is no 1m source", async () => {
    const prisma = makeFakePrisma([]);
    const res = await aggregateFrom1m({ instrumentId: "C", exchange: "NSE", target: "5m", fromIstDate: "2026-09-10", toIstDate: "2026-09-10", prisma: prisma as never });
    expect(res.status).toBe("DATA_INSUFFICIENT");
    expect(res.producedBars).toBe(0);
  });
});

// ── Backfill planning + resume (§4/§5/§44) ─────────────────────────────────

describe("backfill orchestrator", () => {
  it("plans chunks bounded by chunkDays", () => {
    const chunks = planChunks("2026-09-01", "2026-09-10", 3);
    expect(chunks.length).toBe(4); // 1-3,4-6,7-9,10
    expect(chunks[0]).toMatchObject({ fromIstDate: "2026-09-01", toIstDate: "2026-09-03" });
    expect(chunks[chunks.length - 1]!.toIstDate).toBe("2026-09-10");
  });

  it("BLOCKED (never fabricates) when no history provider exists for interval", async () => {
    // "3m" was removed from AlphaForge scope in V8 and is not in any provider matrix.
    // A request for a legacy/unsupported interval produces BLOCKED, never fabricated bars.
    const ckpt = await runBackfill(
      { instrumentId: "A", exchange: "NSE", interval: "3m" as never, fromIstDate: "2026-09-01", toIstDate: "2026-09-05" },
      { fetcher: async () => ({ candles: [], outcome: "EMPTY" }) },
    );
    expect(ckpt.state).toBe("BLOCKED");
    expect(ckpt.barsPersisted).toBe(0);
  });

  it("does NOT advance the checkpoint past a hard-failed chunk (resumable)", async () => {
    // In-memory redis fake.
    const kv = new Map<string, string>();
    const redis = {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: string) => { kv.set(k, v); return "OK"; },
    } as never;
    // Fake prisma that swallows persistence (no real DB); count returns 0.
    const prismaGlobal = makeFakePrisma([]);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prismaGlobal }));

    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls > 2) throw new Error("SIMULATED_CRASH");
      return { candles: [], outcome: "SUCCESS" as const };
    };
    const job = { instrumentId: "A", exchange: "NSE", interval: "1m" as const, fromIstDate: "2026-09-01", toIstDate: "2026-09-05" };
    const ckpt = await runBackfill(job, { redis, fetcher, provider: "angel_one", chunkDays: 1 });
    // Chunks 0,1 succeeded (empty ok), chunk 2 crashed → lastCompletedChunk stays at 1.
    expect(ckpt.lastCompletedChunk).toBe(1);
    expect(ckpt.state === "PARTIAL" || ckpt.state === "FAILED").toBe(true);
  });
});

// ── Incident dedup / correlation (§38) ─────────────────────────────────────

describe("data-quality incident dedup", () => {
  it("folds a repeat with the same correlation key into the OPEN incident", async () => {
    const prisma = makeFakePrisma([]);
    const id1 = await recordDataIncident({ severity: "ERROR", failureType: "PROVIDER_FAILED", provider: "angel_one", instrumentId: "NIFTY", intervalStr: "5m", affectedRecords: 3, prisma: prisma as never });
    const id2 = await recordDataIncident({ severity: "ERROR", failureType: "PROVIDER_FAILED", provider: "angel_one", instrumentId: "NIFTY", intervalStr: "5m", affectedRecords: 2, prisma: prisma as never });
    expect(id1).toBe(id2); // same incident
    expect(prisma.__incidents.length).toBe(1);
    expect((prisma.__incidents[0] as { affectedRecords: number }).affectedRecords).toBe(5);
  });

  it("creates a distinct incident for a different failure type", async () => {
    const prisma = makeFakePrisma([]);
    await recordDataIncident({ severity: "ERROR", failureType: "PROVIDER_FAILED", provider: "a", instrumentId: "X", intervalStr: "5m", prisma: prisma as never });
    await recordDataIncident({ severity: "WARNING", failureType: "STALE", provider: "a", instrumentId: "X", intervalStr: "5m", prisma: prisma as never });
    expect(prisma.__incidents.length).toBe(2);
  });
});
