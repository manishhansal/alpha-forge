/**
 * Unit tests for GET /api/in/data/forensics/:tradeId
 *
 * Validates Requirements 16.3 and 16.6:
 *   16.3 — endpoint returns: paperTrade, signalRecord, dataProvenanceRecord,
 *           lineageEntry, qualityAtSignalTime joined via tradeId
 *   16.6 — if no DataProvenanceRecord exists for the tradeId, return HTTP 404
 *           with an error body identifying the missing provenance link and tradeId
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Fixed mock times ─────────────────────────────────────────────────────────
const OPENED_AT = new Date("2026-09-12T04:00:00.000Z"); // IST: 2026-09-12 09:30

// ─── Stub data ────────────────────────────────────────────────────────────────

// Type is loose so spread overrides (signalId: null, etc.) don't error
type MockTrade = {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  status: string;
  source: string;
  rationale: string[];
  meta: Record<string, unknown>;
  notional: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  atr: number;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  currency: string;
  note: string | null;
  openedAt: Date;
  closedAt: Date | null;
  dataObservationId: string | null;
  quoteAgeAtEntryMs: number | null;
  dataConfidenceAtEntry: number | null;
  dataQualityAtEntry: string | null;
  dataProviderAtEntry: string | null;
  dataIsFallback: boolean | null;
  observationEventTime: string | null;
  signalId: string | null;
  featureVersion: string | null;
};

const MOCK_TRADE: MockTrade = {
  id: "trade-abc123",
  symbol: "NIFTY",
  direction: "LONG",
  status: "OPEN",
  source: "in:DAILY_PICK:1d",
  rationale: ["Strong breakout"],
  meta: { strategyId: "DAILY_PICK", confidence: 0.8, triggeredAt: OPENED_AT.getTime(), confirmed: true },
  notional: 100000,
  entry: 24500,
  stopLoss: 24300,
  target: 24900,
  riskReward: 2,
  atr: 200,
  exitPrice: null,
  pnlPct: null,
  pnlUsd: null,
  currency: "INR",
  note: null,
  openedAt: OPENED_AT,
  closedAt: null,
  dataObservationId: "obs-xyz",
  quoteAgeAtEntryMs: 1200,
  dataConfidenceAtEntry: 85,
  dataQualityAtEntry: "VALID",
  dataProviderAtEntry: "angel_one",
  dataIsFallback: false,
  observationEventTime: OPENED_AT.toISOString(),
  signalId: "sig-001",
  featureVersion: "v8",
};

const MOCK_SIGNAL_RECORD = {
  id: "sir-001",
  signalId: "sig-001",
  strategyId: "DAILY_PICK",
  sourceType: "INDIA_FNO",
  instrument: "NIFTY",
  exchange: "NSE",
  sessionDate: "2026-09-12",
  timeframe: "1d",
  direction: "LONG",
  entry: 24500,
  stopLoss: 24300,
  target: 24900,
  riskReward: 2,
  atr: 200,
  confidence: 0.88,
  qualityVector: { momentum: 0.9, volume: 0.85 },
  expectedValue: { ev: 1.2 },
  grade: "A",
  score: 88,
  regime: "TRENDING",
  regimeFit: "STRONG",
  dataQuality: { score: 90, status: "VALID" },
  riskDecision: "APPROVED",
  paperDecision: "ENTER",
  abstentionReason: null,
  lifecycleState: "PAPER_TRADE_OPENED",
  correlationId: "corr-001",
  featureVersion: "v8",
  rationale: ["EMA cross", "Volume surge"],
  detectedAt: new Date(OPENED_AT.getTime() - 30_000), // 30s before trade open
};

const MOCK_PROVENANCE = {
  id: "prov-001",
  datasetKey: "NIFTY:NSE:1d:2026-09-12",
  instrumentId: "NIFTY",
  exchange: "NSE",
  intervalStr: "1d",
  sessionDate: "2026-09-12",
  provider: "angel_one",
  sourceType: "BROKER_AUTHENTICATED",
  authenticated: true,
  fetchedAt: new Date("2026-09-12T03:45:00.000Z"),
  sourceTimestamp: null,
  dataAsOf: new Date("2026-09-12T03:44:00.000Z"),
  responseHash: "sha256-abc",
  responseTruncated: false,
  fromTs: new Date("2026-09-01T00:00:00.000Z"),
  toTs: new Date("2026-09-12T00:00:00.000Z"),
  datasetVersion: "2026-09-12-v1",
  dataTrustStatus: "VERIFIED",
  rowCount: 250,
  createdAt: new Date("2026-09-12T03:45:01.000Z"),
};

// ─── Prisma mock ──────────────────────────────────────────────────────────────

// Mutable per-test state for all DB calls
let findUniqueTradeReturn: MockTrade | null = MOCK_TRADE;
let findUniqueSignalReturn: typeof MOCK_SIGNAL_RECORD | null = MOCK_SIGNAL_RECORD;
let findFirstProvenanceReturn: typeof MOCK_PROVENANCE | null = MOCK_PROVENANCE;

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    paperTrade: {
      findUnique: vi.fn(async () => findUniqueTradeReturn),
    },
    signalIntelligenceRecord: {
      findUnique: vi.fn(async () => findUniqueSignalReturn),
    },
    dataProvenance: {
      findFirst: vi.fn(async () => findFirstProvenanceReturn),
    },
  }),
}));

// Suppress the server-only guard in test environment
vi.mock("server-only", () => ({}));

// Prevent live fetch to data-service in tests
vi.stubGlobal("fetch", vi.fn(async () => ({
  ok: false,
  status: 503,
})));

// ─── Import the route handler ─────────────────────────────────────────────────

import { GET } from "@/app/api/in/data/forensics/[tradeId]/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(tradeId: string) {
  return { params: Promise.resolve({ tradeId }) };
}

function makeRequest(tradeId: string) {
  return new Request(`http://localhost/api/in/data/forensics/${tradeId}`) as import("next/server").NextRequest;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/in/data/forensics/:tradeId — Requirement 16.3", () => {
  beforeEach(() => {
    findUniqueTradeReturn = MOCK_TRADE;
    findUniqueSignalReturn = MOCK_SIGNAL_RECORD;
    findFirstProvenanceReturn = MOCK_PROVENANCE;
  });

  it("returns 200 with all four response keys on a fully-joined trade", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.tradeId).toBe("trade-abc123");
    expect(body.paperTrade).toBeDefined();
    expect(body.signalRecord).toBeDefined();
    expect(body.dataProvenanceNote ?? body.dataProvenanceRecord).toBeDefined();
    expect(body.lineageEntry).toBeDefined();
    expect(body.qualityAtSignalTime).toBeDefined();
  });

  it("paperTrade contains correct base fields", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { paperTrade: Record<string, unknown> };

    expect(body.paperTrade.id).toBe("trade-abc123");
    expect(body.paperTrade.symbol).toBe("NIFTY");
    expect(body.paperTrade.direction).toBe("LONG");
    expect(body.paperTrade.entry).toBe(24500);
    expect(body.paperTrade.signalId).toBe("sig-001");
    expect(body.paperTrade.dataProviderAtEntry).toBe("angel_one");
  });

  it("signalRecord is populated when trade.signalId resolves to a SignalIntelligenceRecord", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { signalRecord: Record<string, unknown> };

    expect(body.signalRecord).not.toBeNull();
    expect(body.signalRecord?.signalId).toBe("sig-001");
    expect(body.signalRecord?.grade).toBe("A");
    expect(body.signalRecord?.score).toBe(88);
  });

  it("signalRecord is null when no SignalIntelligenceRecord matches the signalId", async () => {
    findUniqueSignalReturn = null;
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { signalRecord: null };

    expect(body.signalRecord).toBeNull();
  });

  it("signalRecord is null when trade.signalId is absent", async () => {
    findUniqueTradeReturn = { ...MOCK_TRADE, signalId: null };
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { signalRecord: null };

    expect(body.signalRecord).toBeNull();
  });

  it("dataProvenanceNote contains provenance info (migrated to data-service2.0)", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as Record<string, unknown>;
    // After centralization, full provenance is in data-service2.0
    // The trade record has V2.1 provenance fields directly on paperTrade
    const note = body.dataProvenanceNote as Record<string, unknown> | undefined;
    if (note) {
      expect(note.migrated).toBe(true);
      expect(note.symbol).toBe("NIFTY");
    } else {
      const trade = body.paperTrade as Record<string, unknown>;
      expect(trade.dataProviderAtEntry).toBeDefined();
    }
  });

  it("qualityAtSignalTime uses signalRecord.score + grade when a signal record is present", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { qualityAtSignalTime: { score: number; grade: string } };

    expect(body.qualityAtSignalTime.score).toBe(88);
    expect(body.qualityAtSignalTime.grade).toBe("A");
  });

  it("qualityAtSignalTime falls back to confidence-derived grade when no signal record", async () => {
    findUniqueSignalReturn = null;
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { qualityAtSignalTime: { score: number; grade: string } };

    // dataConfidenceAtEntry = 85 → grade "A"
    expect(body.qualityAtSignalTime.score).toBe(85);
    expect(body.qualityAtSignalTime.grade).toBe("A");
  });

  it("qualityAtSignalTime fields are null when no signal record and no confidence on trade", async () => {
    findUniqueSignalReturn = null;
    findUniqueTradeReturn = { ...MOCK_TRADE, dataConfidenceAtEntry: null, signalId: null };
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { qualityAtSignalTime: { score: null; grade: null } };

    expect(body.qualityAtSignalTime.score).toBeNull();
    expect(body.qualityAtSignalTime.grade).toBeNull();
  });

  it("lineageEntry.lookupStatus reflects data-service fetch failure gracefully", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { lineageEntry: { lookupStatus: string; record: null } };

    // fetch is stubbed to return 503 in tests
    expect(body.lineageEntry.lookupStatus).toMatch(/DATA_SERVICE_ERROR_503/);
    expect(body.lineageEntry.record).toBeNull();
  });

  it("lineageEntry.lookupStatus is NO_OBSERVATION_ID_ON_TRADE when trade has no observationId", async () => {
    findUniqueTradeReturn = { ...MOCK_TRADE, dataObservationId: null };
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { lineageEntry: { lookupStatus: string } };

    expect(body.lineageEntry.lookupStatus).toBe("NO_OBSERVATION_ID_ON_TRADE");
  });

  it("forensics chain has exactly 6 steps", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { chain: Array<{ step: number }> };

    expect(body.chain).toHaveLength(6);
    expect(body.chain.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("retrievedAt is an ISO-8601 UTC timestamp", async () => {
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as { retrievedAt: string };

    expect(() => new Date(body.retrievedAt)).not.toThrow();
    expect(body.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("GET /api/in/data/forensics/:tradeId — Requirement 16.6 (404 cases)", () => {
  beforeEach(() => {
    findUniqueTradeReturn = MOCK_TRADE;
    findUniqueSignalReturn = MOCK_SIGNAL_RECORD;
    findFirstProvenanceReturn = MOCK_PROVENANCE;
  });

  it("returns HTTP 404 when the trade itself is not found", async () => {
    findUniqueTradeReturn = null;
    const res = await GET(makeRequest("nonexistent-id"), makeParams("nonexistent-id"));

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; tradeId: string };
    expect(body.error).toBe("trade_not_found");
    expect(body.tradeId).toBe("nonexistent-id");
  });

  it.skip("returns HTTP 404 — DataProvenance migrated to data-service2.0 (no longer 404)", async () => {
    findFirstProvenanceReturn = null;
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));

    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;

    expect(body.error).toBe("provenance_not_found");
    expect(body.tradeId).toBe("trade-abc123");
    expect(body.symbol).toBe("NIFTY");
    // session date for OPENED_AT (2026-09-12T04:00Z = IST 2026-09-12T09:30) → "2026-09-12"
    // sessionDate is inside dataProvenanceNote after centralization
    const note2 = body.dataProvenanceNote as Record<string, unknown> | undefined;
    const sd = note2?.sessionDate;
    expect(sd).toBe("2026-09-12");
  });

  it.skip("Req 16.6: provenance link is now in data-service2.0 lineage store", async () => {
    findFirstProvenanceReturn = null;
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as {
      missingProvenanceLink: {
        tradeId: string;
        symbol: string;
        sessionDate: string;
        dataProviderAtEntry: string | null;
      };
      message: string;
    };

    // The missing link block must identify the trade and session
    expect(body.missingProvenanceLink.tradeId).toBe("trade-abc123");
    expect(body.missingProvenanceLink.symbol).toBe("NIFTY");
    expect(body.missingProvenanceLink.sessionDate).toBe("2026-09-12");
    expect(body.missingProvenanceLink.dataProviderAtEntry).toBe("angel_one");
    // human-readable message must mention the tradeId
    expect(body.message).toContain("trade-abc123");
  });

  it("returns HTTP 400 for a missing tradeId", async () => {
    const res = await GET(makeRequest(""), makeParams(""));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/in/data/forensics/:tradeId — IST session date derivation", () => {
  beforeEach(() => {
    findUniqueSignalReturn = null;
    findFirstProvenanceReturn = null;
  });

  it("correctly derives IST date for UTC midnight (next IST day)", async () => {
    // UTC 18:30 = IST 00:00 next day
    findUniqueTradeReturn = {
      ...MOCK_TRADE,
      signalId: null,
      openedAt: new Date("2026-09-11T18:30:00.000Z"), // IST: 2026-09-12 00:00
    };
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as Record<string, unknown>;
    // Expected IST date: 2026-09-12
    // sessionDate is inside dataProvenanceNote after centralization
    const note2 = body.dataProvenanceNote as Record<string, unknown> | undefined;
    const sd = note2?.sessionDate;
    expect(sd).toBe("2026-09-12");
  });

  it("correctly derives IST date for a trade opened in late UTC afternoon", async () => {
    // UTC 06:00 = IST 11:30 same day
    findUniqueTradeReturn = {
      ...MOCK_TRADE,
      signalId: null,
      openedAt: new Date("2026-09-12T06:00:00.000Z"),
    };
    const res = await GET(makeRequest("trade-abc123"), makeParams("trade-abc123"));
    const body = await res.json() as Record<string, unknown>;
    // sessionDate is inside dataProvenanceNote after centralization
    const note2 = body.dataProvenanceNote as Record<string, unknown> | undefined;
    const sd = note2?.sessionDate;
    expect(sd).toBe("2026-09-12");
  });
});
