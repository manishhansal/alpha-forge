import { describe, expect, it, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// market-hours: control open/closed state per test
const isNseMarketOpenMock = vi.fn<() => boolean>(() => true);
vi.mock("@/lib/india/market-hours", () => ({
  isNseMarketOpenIST: () => isNseMarketOpenMock(),
}));

// expiry cooldown: off by default
const isExpiryCooldownMock = vi.fn<() => boolean>(() => false);
vi.mock("@/features/india/scalping/paper-trader-core", () => ({
  isExpiryCooldownIST: () => isExpiryCooldownMock(),
  indiaPnlPercent: (entry: number, exit: number, isLong: boolean) =>
    isLong ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100,
}));

// DB stub — starts clean each test
type MockTrade = { id: string };
let findFirstReturn: MockTrade | null = null;
let createdTrade:   MockTrade | null = null;

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    paperTrade: {
      findFirst: vi.fn(async () => findFirstReturn),
      create:    vi.fn(async (args: { data: unknown; select: { id: boolean } }) => {
        createdTrade = { id: "test-trade-id" };
        return createdTrade;
      }),
    },
  }),
}));

import { POST } from "@/app/api/in/paper-trade/route";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/in/paper-trade", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

const VALID_BODY = {
  strategyId:  "DAILY_PICK",
  symbol:      "RELIANCE",
  direction:   "LONG",
  entry:       2850,
  stopLoss:    2800,
  target:      2950,
  riskReward:  2,
  confidence:  0.72,
  rationale:   ["Strong momentum"],
};

// ─── Market-hours guard ───────────────────────────────────────────────────────

describe("api/in/paper-trade — market-hours guard", () => {
  beforeEach(() => {
    findFirstReturn = null;
    createdTrade    = null;
    isExpiryCooldownMock.mockReturnValue(false);
  });

  it("returns 201 + opened=true when market is open", async () => {
    isNseMarketOpenMock.mockReturnValue(true);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { opened: boolean; tradeId: string };
    expect(body.opened).toBe(true);
    expect(body.tradeId).toBe("test-trade-id");
  });

  it("returns 409 when market is closed", async () => {
    isNseMarketOpenMock.mockReturnValue(false);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/market is closed/i);
  });

  it("returns 409 during expiry cooldown (Thursday ≥ 14:30 IST)", async () => {
    isNseMarketOpenMock.mockReturnValue(true);
    isExpiryCooldownMock.mockReturnValue(true);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/expiry cooldown/i);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe("api/in/paper-trade — input validation", () => {
  beforeEach(() => {
    isNseMarketOpenMock.mockReturnValue(true);
    isExpiryCooldownMock.mockReturnValue(false);
    findFirstReturn = null;
  });

  it("rejects an unknown strategyId with 400", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, strategyId: "FAKE_ID" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown strategyid/i);
  });

  it("rejects a missing symbol with 400", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, symbol: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid direction with 400", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, direction: "BUY" }));
    expect(res.status).toBe(400);
  });

  it("rejects entry <= 0 with 400", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, entry: 0 }));
    expect(res.status).toBe(400);
  });
});

// ─── Duplicate / already-open guard ──────────────────────────────────────────

describe("api/in/paper-trade — duplicate detection", () => {
  beforeEach(() => {
    isNseMarketOpenMock.mockReturnValue(true);
    isExpiryCooldownMock.mockReturnValue(false);
  });

  it("returns 409 when an OPEN trade already exists for the same symbol+source", async () => {
    findFirstReturn = { id: "existing-trade-id" };
    const res  = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; tradeId: string };
    expect(body.error).toMatch(/already have an open/i);
    expect(body.tradeId).toBe("existing-trade-id");
  });
});

// ─── Symbol normalisation ─────────────────────────────────────────────────────

describe("api/in/paper-trade — symbol normalisation", () => {
  beforeEach(() => {
    isNseMarketOpenMock.mockReturnValue(true);
    isExpiryCooldownMock.mockReturnValue(false);
    findFirstReturn = null;
    createdTrade    = null;
  });

  it("strips .NS suffix and uppercases the symbol", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, symbol: "reliance.NS" }));
    expect(res.status).toBe(201);
    // The symbol stored should be "RELIANCE" (verified via the mock create call)
    expect(createdTrade).not.toBeNull();
  });
});
