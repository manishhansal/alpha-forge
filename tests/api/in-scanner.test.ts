import { describe, expect, it, vi } from "vitest";

import type { ScannerResult, ScannerType } from "@/types/india/scanner";

// The route handler delegates everything to `runScanner` (a thin facade
// around several worker modules). Mock that one boundary so the API test
// stays deterministic and never touches Yahoo / NSE network endpoints.
const runScannerMock = vi.fn<(type: ScannerType, limit?: number) => Promise<ScannerResult>>();
vi.mock("@/services/india/scanner/engine", () => ({
  runScanner: (type: ScannerType, limit?: number) => runScannerMock(type, limit),
}));

import { GET } from "@/app/api/in/scanner/route";

function makeRequest(qs: string): Request {
  return new Request(`http://localhost/api/in/scanner${qs}`);
}

describe("api/in/scanner", () => {
  it("rejects an unknown scanner type with 400 and a `valid` list", async () => {
    runScannerMock.mockReset();
    const res = await GET(makeRequest("?type=does-not-exist"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; valid: string[] };
    expect(body.error).toMatch(/Unknown scanner type/i);
    expect(body.valid).toContain("momentum");
    expect(runScannerMock).not.toHaveBeenCalled();
  });

  it("defaults to type=momentum with limit=25 when no params are given", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockResolvedValueOnce({
      type: "momentum",
      generatedAt: new Date().toISOString(),
      rows: [],
    } as unknown as ScannerResult);

    const res = await GET(makeRequest(""));
    expect(res.status).toBe(200);
    expect(runScannerMock).toHaveBeenCalledWith("momentum", 25);
  });

  it("clamps the `limit` query param into [5, 100]", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockResolvedValue({
      type: "momentum",
      generatedAt: new Date().toISOString(),
      rows: [],
    } as unknown as ScannerResult);

    await GET(makeRequest("?limit=1"));
    await GET(makeRequest("?limit=9999"));
    await GET(makeRequest("?limit=42"));

    const limits = runScannerMock.mock.calls.map((c) => c[1]);
    expect(limits).toEqual([5, 100, 42]);
  });

  it("forwards Cache-Control: no-store on success", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockResolvedValueOnce({
      type: "momentum",
      generatedAt: new Date().toISOString(),
      rows: [],
    } as unknown as ScannerResult);

    const res = await GET(makeRequest("?type=momentum"));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 502 with the engine's error message when runScanner throws", async () => {
    runScannerMock.mockReset();
    runScannerMock.mockRejectedValueOnce(new Error("upstream timeout"));

    const res = await GET(makeRequest("?type=momentum"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; type: string };
    expect(body.error).toBe("upstream timeout");
    expect(body.type).toBe("momentum");
  });
});
