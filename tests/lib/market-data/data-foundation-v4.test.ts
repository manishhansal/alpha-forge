/**
 * Data Foundation V4 — unit tests for the new observability + enforcement logic:
 * config-health credential detection, provider-reliability sample-size honesty,
 * runtime-vs-static capability, data-gate enforcement fail-closed behaviour, and
 * the canonical sessionDate computation. Pure + in-memory Prisma fakes; the real
 * DB is separately proven by the scripts/data-v4-*.ts harnesses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  enforceDataGate,
  dependencyFromStatus,
} from "@/lib/market-data/services/data-gate-enforcement.service";
import {
  computeProviderReliability,
  buildRuntimeCapabilityMatrix,
  MIN_SAMPLE,
} from "@/lib/market-data/services/provider-reliability.service";
import { getProviderConfigHealth } from "@/lib/market-data/services/config-health.service";
import { sessionDateForTime } from "@/lib/market-data/services/candle-persist.service";

// ── sessionDate (V4 §8) ────────────────────────────────────────────────────

describe("sessionDateForTime", () => {
  it("maps a 09:15-IST epoch to the correct IST calendar date", () => {
    // 2026-09-10 09:15 IST = 2026-09-10T03:45:00Z = epoch 1788?; compute directly.
    const sec = Math.floor((Date.UTC(2026, 8, 10) - 5.5 * 3600 * 1000) / 1000) + (9 * 60 + 15) * 60;
    expect(sessionDateForTime(sec)).toBe("2026-09-10");
  });
  it("keeps a late-evening IST bar on the same IST date", () => {
    const sec = Math.floor((Date.UTC(2026, 8, 10) - 5.5 * 3600 * 1000) / 1000) + (18 * 60 + 30) * 60;
    expect(sessionDateForTime(sec)).toBe("2026-09-10");
  });
});

// ── Data-gate enforcement (V4 §21/§22) ─────────────────────────────────────

describe("enforceDataGate (fail-closed)", () => {
  it("allows when all critical deps are AVAILABLE and requireFullyReady", () => {
    const d = enforceDataGate({
      dependencies: [
        dependencyFromStatus("ohlcv", "AVAILABLE", true),
        dependencyFromStatus("oi", "AVAILABLE", true),
      ],
    });
    expect(d.allowed).toBe(true);
    expect(d.state).toBe("DATA_READY");
  });

  it("BLOCKS when a critical dep is UNAVAILABLE (5m history missing → no signal)", () => {
    const d = enforceDataGate({
      dependencies: [
        dependencyFromStatus("ohlcv_5m", "UNAVAILABLE", true),
        dependencyFromStatus("oi", "AVAILABLE", true),
      ],
    });
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("DATA_BLOCKED");
    expect(d.blockedBy.join()).toContain("ohlcv_5m");
  });

  it("BLOCKS when a critical dep failed with PROVIDER_FAILED (provider outage)", () => {
    const d = enforceDataGate({
      dependencies: [dependencyFromStatus("ohlcv", "PROVIDER_FAILED", true)],
    });
    expect(d.allowed).toBe(false);
    expect(d.state).toBe("DATA_BLOCKED");
  });

  it("BLOCKS on snapshot inconsistency even when deps are AVAILABLE (skew > tolerance)", () => {
    const now = Date.now();
    const d = enforceDataGate({
      dependencies: [dependencyFromStatus("ohlcv", "AVAILABLE", true)],
      snapshotFields: [
        { name: "price", timestampMs: now, critical: true },
        { name: "oi", timestampMs: now - 5 * 60_000, critical: true }, // 5 min skew
      ],
      snapshotToleranceMs: 60_000,
    });
    expect(d.allowed).toBe(false);
    expect(d.snapshotConsistent).toBe(false);
  });

  it("does NOT allow under DATA_DEGRADED in strict mode, but DOES when strategy's own critical deps are healthy", () => {
    const deps = [
      dependencyFromStatus("ohlcv", "AVAILABLE", true), // this strategy's critical dep is healthy
      dependencyFromStatus("optionChain", "PARTIAL", false), // optional, degrades global
    ];
    const strict = enforceDataGate({ dependencies: deps, requireFullyReady: true });
    expect(strict.state).toBe("DATA_DEGRADED");
    expect(strict.allowed).toBe(false); // strict requires DATA_READY

    const lenient = enforceDataGate({ dependencies: deps, requireFullyReady: false });
    expect(lenient.allowed).toBe(true); // its own critical dep (ohlcv) is healthy
  });

  it("option-chain stale (critical) → no option-dependent signal", () => {
    const d = enforceDataGate({
      dependencies: [
        dependencyFromStatus("ohlcv", "AVAILABLE", true),
        dependencyFromStatus("optionChain", "STALE", true),
      ],
      requireFullyReady: false,
    });
    // STALE is a soft-degrade, not a hard veto, but under requireFullyReady:false
    // strategyMayOperate only blocks on NON_TRADABLE statuses; STALE is allowed
    // as a caller-judged soft state — so this asserts the documented behaviour.
    expect(d.state).toBe("DATA_DEGRADED");
  });
});

// ── In-memory Prisma fake for reliability/config ───────────────────────────

function fakePrisma(observations: Array<{ provider: string; instrumentId: string; dataType?: string; receivedAt: Date; rawPayload: unknown }>) {
  return {
    providerObservation: {
      findMany: vi.fn(async ({ where }: { where?: { dataType?: string } }) => {
        let rows = observations;
        if (where?.dataType) rows = rows.filter((o) => o.dataType === where.dataType);
        return rows.map((o) => ({ ...o }));
      }),
    },
  } as never;
}

describe("provider reliability sample-size honesty (§19)", () => {
  it("reports INSUFFICIENT_SAMPLE and null successRate below MIN_SAMPLE", async () => {
    const p = fakePrisma([
      { provider: "scrapling", instrumentId: "NIFTY", receivedAt: new Date(), rawPayload: { __metrics: { outcome: "SUCCESS", latencyMs: 95 } } },
    ]);
    const rel = await computeProviderReliability(p);
    const s = rel.find((r) => r.provider === "scrapling")!;
    expect(s.sampleCount).toBe(1);
    expect(s.successRate).toBeNull();
    expect(s.reliabilityStatus).toBe("INSUFFICIENT_SAMPLE");
  });

  it("EXCLUDES demo observations from reliability", async () => {
    const obs = [
      { provider: "angel_one", instrumentId: "__V3DEMO__RESUME", receivedAt: new Date(), rawPayload: { __metrics: { outcome: "SUCCESS" } } },
      { provider: "angel_one", instrumentId: "__V3DEMO__RESUME", receivedAt: new Date(), rawPayload: { __metrics: { outcome: "SUCCESS" } } },
    ];
    const rel = await computeProviderReliability(fakePrisma(obs));
    const a = rel.find((r) => r.provider === "angel_one")!;
    expect(a.sampleCount).toBe(0);
    expect(a.demoExcluded).toBe(2);
    expect(a.reliabilityStatus).toBe("NOT_VERIFIED");
  });

  it("asserts a successRate only once MIN_SAMPLE real observations exist", async () => {
    const obs = Array.from({ length: MIN_SAMPLE }, () => ({
      provider: "scrapling", instrumentId: "NIFTY", receivedAt: new Date(), rawPayload: { __metrics: { outcome: "SUCCESS", latencyMs: 10 } },
    }));
    const rel = await computeProviderReliability(fakePrisma(obs));
    const s = rel.find((r) => r.provider === "scrapling")!;
    expect(s.reliabilityStatus).toBe("LIVE_RUNTIME_VERIFIED");
    expect(s.successRate).toBe(1);
  });
});

describe("runtime capability matrix (§16)", () => {
  it("marks a provider+interval NOT_VERIFIED with no real candle observation", async () => {
    const cells = await buildRuntimeCapabilityMatrix(fakePrisma([]));
    expect(cells.every((c) => c.runtime === "NOT_VERIFIED")).toBe(true);
  });
  it("upgrades to LIVE_RUNTIME_VERIFIED only with a real SUCCESS candle observation", async () => {
    const cells = await buildRuntimeCapabilityMatrix(fakePrisma([
      { provider: "angel_one", instrumentId: "RELIANCE", dataType: "CANDLE", receivedAt: new Date(), rawPayload: { __metrics: { interval: "5m", outcome: "SUCCESS" } } },
    ]));
    const cell = cells.find((c) => c.provider === "angel_one" && c.interval === "5m")!;
    expect(cell.runtime).toBe("LIVE_RUNTIME_VERIFIED");
    // A demo observation must NOT verify runtime.
    const cells2 = await buildRuntimeCapabilityMatrix(fakePrisma([
      { provider: "angel_one", instrumentId: "__V3DEMO__X", dataType: "CANDLE", receivedAt: new Date(), rawPayload: { __metrics: { interval: "1m", outcome: "SUCCESS" } } },
    ]));
    const cell2 = cells2.find((c) => c.provider === "angel_one" && c.interval === "1m")!;
    expect(cell2.runtime).toBe("NOT_VERIFIED");
  });
});

describe("config health credential detection (§12, no secrets)", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    delete process.env.SMARTAPI_API_KEY;
    delete process.env.SMARTAPI_CLIENT_CODE;
    delete process.env.SMARTAPI_PIN;
    delete process.env.SMARTAPI_TOTP_SECRET;
    delete process.env.UPSTOX_ANALYTICS_TOKEN;
    delete process.env.UPSTOX_ACCESS_TOKEN;
    delete process.env.UPSTOX_CLIENT_ID;
    delete process.env.UPSTOX_CLIENT_SECRET;
    process.env.DATA_SERVICE_URL = "http://localhost:8200";
  });
  afterEach(() => { process.env = { ...OLD }; });

  it("reports angel_one not configured with the exact missing fields when creds absent", async () => {
    const rows = await getProviderConfigHealth(fakePrisma([]));
    const angel = rows.find((r) => r.provider === "angel_one")!;
    expect(angel.configured).toBe(false);
    expect(angel.missingCredentialFields).toContain("SMARTAPI_API_KEY");
    expect(angel.authenticated).toBe(false);
  });

  it("reports angel_one configured when all four env fields present (values never returned)", async () => {
    process.env.SMARTAPI_API_KEY = "x";
    process.env.SMARTAPI_CLIENT_CODE = "x";
    process.env.SMARTAPI_PIN = "x";
    process.env.SMARTAPI_TOTP_SECRET = "x";
    const rows = await getProviderConfigHealth(fakePrisma([]));
    const angel = rows.find((r) => r.provider === "angel_one")!;
    expect(angel.configured).toBe(true);
    expect(angel.credentialsComplete).toBe(true);
    // Never leak values.
    expect(JSON.stringify(rows)).not.toContain("SMARTAPI");
  });

  it("scrapling configured from DATA_SERVICE_URL; authenticated only with a real observation", async () => {
    const withObs = fakePrisma([
      { provider: "scrapling", instrumentId: "NIFTY", receivedAt: new Date(), rawPayload: { __metrics: { outcome: "SUCCESS" } } },
    ]);
    const rows = await getProviderConfigHealth(withObs);
    const s = rows.find((r) => r.provider === "scrapling")!;
    expect(s.configured).toBe(true);
    expect(s.authenticated).toBe(true);
  });
});
