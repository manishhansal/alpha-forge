import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/services/india/nse", () => ({ nse: { getOptionChain: vi.fn() } }));
vi.mock("@/services/india/yahoo", () => ({ yahoo: { getQuotes: vi.fn() } }));

import { nse } from "@/services/india/nse";
import { yahoo } from "@/services/india/yahoo";
import { captureOptionChainSnapshots } from "@/features/india/scalping/option-chain-capture";
import type { OptionChain } from "@/types/india";

const mockedChain = nse.getOptionChain as unknown as ReturnType<typeof vi.fn>;
const mockedQuotes = yahoo.getQuotes as unknown as ReturnType<typeof vi.fn>;

function chain(over: Partial<OptionChain> = {}): OptionChain {
  return {
    symbol: "NIFTY",
    spot: 22000,
    expiry: "2026-06-25",
    expiries: ["2026-06-25"],
    rows: [],
    analytics: {
      pcrOi: 1.15,
      pcrVolume: 0.95,
      maxCeOiStrike: 22200,
      maxPeOiStrike: 21800,
      totalCeOi: 5_000_000,
      totalPeOi: 5_750_000,
      totalCeOiChange: 120_000,
      totalPeOiChange: 240_000,
      atmIv: 13.4,
      maxPain: 22000,
    },
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

function fakePrisma() {
  const create = vi.fn().mockResolvedValue({ id: "snap-1" });
  const findMany = vi.fn().mockResolvedValue([]);
  return {
    prisma: { optionChainSnapshot: { create, findMany } } as unknown as PrismaClient,
    create,
    findMany,
  };
}

beforeEach(() => {
  mockedChain.mockReset();
  mockedQuotes.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("india/scalping/option-chain-capture — captureOptionChainSnapshots", () => {
  it("persists a snapshot row with analytics + spot + day change for an underlying", async () => {
    mockedQuotes.mockResolvedValue([{ symbol: "^NSEI", changePct: 0.42 }]);
    mockedChain.mockResolvedValue(chain());
    const { prisma, create } = fakePrisma();

    const res = await captureOptionChainSnapshots({ prisma, underlyings: ["NIFTY"] });

    expect(res.captured).toBe(1);
    expect(res.errors).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data.underlying).toBe("NIFTY");
    expect(data.spot).toBe(22000);
    expect(data.changePct).toBeCloseTo(0.42, 5);
    expect(data.pcrOi).toBeCloseTo(1.15, 5);
    expect(data.maxPain).toBe(22000);
    expect(data.totalPeOiChange).toBe(240_000);
    expect(data.analytics).toMatchObject({ atmIv: 13.4 });
  });

  it("counts a failed chain fetch as an error without throwing", async () => {
    mockedQuotes.mockResolvedValue([{ symbol: "^NSEI", changePct: null }]);
    mockedChain.mockRejectedValue(new Error("NSE throttled"));
    const { prisma, create } = fakePrisma();

    const res = await captureOptionChainSnapshots({ prisma, underlyings: ["NIFTY"] });

    expect(res.captured).toBe(0);
    expect(res.errors).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("still captures when the quote lookup fails (changePct null)", async () => {
    mockedQuotes.mockRejectedValue(new Error("quotes down"));
    mockedChain.mockResolvedValue(chain());
    const { prisma, create } = fakePrisma();

    const res = await captureOptionChainSnapshots({ prisma, underlyings: ["NIFTY"] });

    expect(res.captured).toBe(1);
    expect(create.mock.calls[0][0].data.changePct).toBeNull();
  });
});
