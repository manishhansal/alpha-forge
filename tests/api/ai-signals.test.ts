import { describe, expect, it, vi } from "vitest";

const getCryptoMock = vi.fn();
const getIndiaMock = vi.fn();

vi.mock("@/features/ai-signals/crypto-builder", () => ({
  getCryptoAiSignals: () => getCryptoMock(),
}));

vi.mock("@/features/ai-signals/india-builder", () => ({
  getIndiaAiSignals: () => getIndiaMock(),
}));

import { GET as cryptoGET } from "@/app/api/ai-signals/route";
import { GET as indiaGET } from "@/app/api/in/ai-signals/route";

const sampleResponse = (market: "crypto" | "india") => ({
  market,
  generatedAt: 1700000000000,
  modelVersion: "alphaforge-ai-v1",
  context: {
    market,
    regime: "mixed" as const,
    regimeScore: 0,
    headline: "Mixed",
    bullets: [],
    inActiveWindow: false,
    windowLabel: "Closed",
    dataFreshness: "live",
  },
  signals: [],
  stats: { bullish: 0, bearish: 0, wait: 0, avgConfidence: 0, topGrade: null },
});

describe("api/ai-signals (crypto)", () => {
  it("returns 200 with the engine payload + cache headers", async () => {
    getCryptoMock.mockReset();
    getCryptoMock.mockResolvedValueOnce(sampleResponse("crypto"));

    const res = await cryptoGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, s-maxage=\d+/);
    const body = (await res.json()) as { market: string };
    expect(body.market).toBe("crypto");
  });

  it("maps engine failures to 502 with AI_SIGNALS_FAILED code", async () => {
    getCryptoMock.mockReset();
    getCryptoMock.mockRejectedValueOnce(new Error("upstream down"));

    const res = await cryptoGET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: boolean;
      code: string;
      message: string;
    };
    expect(body.error).toBe(true);
    expect(body.code).toBe("AI_SIGNALS_FAILED");
    expect(body.message).toBe("upstream down");
  });
});

describe("api/in/ai-signals (india)", () => {
  it("returns 200 with the india engine payload", async () => {
    getIndiaMock.mockReset();
    getIndiaMock.mockResolvedValueOnce(sampleResponse("india"));

    const res = await indiaGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { market: string };
    expect(body.market).toBe("india");
  });

  it("maps engine failures to 502 with INDIA_AI_SIGNALS_FAILED code", async () => {
    getIndiaMock.mockReset();
    getIndiaMock.mockRejectedValueOnce(new Error("nse blocked"));

    const res = await indiaGET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: boolean;
      code: string;
      message: string;
    };
    expect(body.error).toBe(true);
    expect(body.code).toBe("INDIA_AI_SIGNALS_FAILED");
    expect(body.message).toBe("nse blocked");
  });
});
