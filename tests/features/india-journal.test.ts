import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  cancelIndiaOpenTrade,
  countIndiaPaperTrades,
  getIndiaJournalStats,
  listIndiaOpenTrades,
  listIndiaPaperTrades,
  setIndiaTradeNote,
} from "@/features/india/scalping/journal";

/**
 * The India journal is the segregation boundary between the two
 * markets in the shared `PaperTrade` Postgres table. Every public
 * helper MUST filter on `source` such that:
 *   - crypto rows (no `in:` prefix) are never returned, and
 *   - the `in:` prefix is enforced even when a caller supplies an
 *     unprefixed source string (e.g. via a hand-rolled query).
 *
 * Because we don't want to spin up Postgres for unit tests, we pass a
 * tiny stub Prisma client into each helper and inspect the `where`
 * clause it received. This is the same boundary the route handlers
 * test against, so we get end-to-end confidence without a real DB.
 */

interface StubCall {
  fn: "findMany" | "count" | "findUnique" | "update";
  args: { where?: unknown; data?: unknown; select?: unknown };
}

function buildStubPrisma(opts: {
  findManyReturn?: unknown;
  countReturn?: number;
  findUniqueReturn?: unknown;
} = {}): { client: PrismaClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const findMany = vi.fn(async (args: { where?: unknown; select?: unknown }) => {
    calls.push({ fn: "findMany", args });
    return opts.findManyReturn ?? [];
  });
  const count = vi.fn(async (args: { where?: unknown }) => {
    calls.push({ fn: "count", args });
    return opts.countReturn ?? 0;
  });
  const findUnique = vi.fn(async (args: { where?: unknown; select?: unknown }) => {
    calls.push({ fn: "findUnique", args });
    return opts.findUniqueReturn ?? null;
  });
  const update = vi.fn(async (args: { where?: unknown; data?: unknown }) => {
    calls.push({ fn: "update", args });
    return null;
  });

  const client = {
    paperTrade: { findMany, count, findUnique, update },
  } as unknown as PrismaClient;

  return { client, calls };
}

function getSourceWhere(
  where: unknown,
): { source: { in: string[] } } | null {
  if (!where || typeof where !== "object") return null;
  const w = where as { source?: { in?: string[] } };
  if (!w.source || !Array.isArray(w.source.in)) return null;
  return { source: { in: w.source.in } };
}

describe("features/india/scalping/journal — source-prefix segregation", () => {
  it("listIndiaPaperTrades scopes the where.source to in:-prefixed strings by default", async () => {
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades({}, client);
    const call = calls.find((c) => c.fn === "findMany");
    expect(call).toBeDefined();
    const where = getSourceWhere(call!.args.where);
    expect(where).not.toBeNull();
    expect(where!.source.in.length).toBeGreaterThan(0);
    for (const s of where!.source.in) {
      expect(s.startsWith("in:")).toBe(true);
    }
  });

  it("listIndiaPaperTrades expands strategy filter into in:<id>:<tf> sources only", async () => {
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades({ strategyIds: ["MOMENTUM"] }, client);
    const call = calls.find((c) => c.fn === "findMany");
    const where = getSourceWhere(call!.args.where);
    expect(where).not.toBeNull();
    // 3 timeframes × 1 strategy = 3 sources.
    expect(where!.source.in.sort()).toEqual([
      "in:MOMENTUM:15m",
      "in:MOMENTUM:1m",
      "in:MOMENTUM:5m",
    ]);
  });

  it("listIndiaPaperTrades drops caller-supplied sources that lack the in: prefix", async () => {
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades(
      { sources: ["UT_SMC:5m", "in:MOMENTUM:5m"] },
      client,
    );
    const call = calls.find((c) => c.fn === "findMany");
    const where = getSourceWhere(call!.args.where);
    expect(where).not.toBeNull();
    expect(where!.source.in).toEqual(["in:MOMENTUM:5m"]);
  });

  it("listIndiaPaperTrades pushes the symbol filter into the Prisma where clause", async () => {
    // After the `20260518050000_papertrade_symbol_string` migration the
    // column is a free-form `String`, so symbol filtering happens at
    // the Prisma layer (and is served by the
    // `PaperTrade_symbol_openedAt_idx` index) instead of being applied
    // in-memory the way it was while the column was the SymbolEnum.
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades({ symbol: "NIFTY" }, client);
    const call = calls.find((c) => c.fn === "findMany");
    expect(call!.args.where).toBeDefined();
    expect((call!.args.where as Record<string, unknown>).symbol).toBe("NIFTY");
  });

  it("listIndiaPaperTrades normalises the caller-supplied symbol to uppercase", async () => {
    // NSE tickers are stored uppercase by the F&O paper-trader, so
    // we uppercase whatever the caller hands us before pushing it
    // into the Prisma equality filter — otherwise a stray lowercase
    // value from a URL bar would silently miss every row.
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades({ symbol: "  reliance  " }, client);
    const call = calls.find((c) => c.fn === "findMany");
    expect((call!.args.where as Record<string, unknown>).symbol).toBe(
      "RELIANCE",
    );
  });

  it("listIndiaPaperTrades omits the symbol filter when given an empty string", async () => {
    const { client, calls } = buildStubPrisma();
    await listIndiaPaperTrades({ symbol: "   " }, client);
    const call = calls.find((c) => c.fn === "findMany");
    expect((call!.args.where as Record<string, unknown>).symbol).toBeUndefined();
  });

  it("countIndiaPaperTrades always uses Prisma count(), even with a symbol filter", async () => {
    // Pre-migration the count path forked into a full `findMany` so
    // the in-memory symbol filter could be applied. With the column
    // now a String, both the symbol and source filters can ride on
    // the cheap COUNT query — confirm that's what we do.
    const { client, calls } = buildStubPrisma({ countReturn: 7 });
    const n = await countIndiaPaperTrades({}, client);
    expect(n).toBe(7);
    expect(calls.find((c) => c.fn === "count")).toBeDefined();
    expect(calls.find((c) => c.fn === "findMany")).toBeUndefined();

    const second = buildStubPrisma({ countReturn: 3 });
    const m = await countIndiaPaperTrades({ symbol: "NIFTY" }, second.client);
    expect(m).toBe(3);
    const countCall = second.calls.find((c) => c.fn === "count");
    expect(countCall).toBeDefined();
    expect(second.calls.find((c) => c.fn === "findMany")).toBeUndefined();
    expect(
      (countCall!.args.where as Record<string, unknown>).symbol,
    ).toBe("NIFTY");
  });

  it("listIndiaOpenTrades restricts to status=OPEN and in:-prefixed sources", async () => {
    const { client, calls } = buildStubPrisma();
    await listIndiaOpenTrades(client);
    const call = calls.find((c) => c.fn === "findMany");
    expect(call).toBeDefined();
    const where = call!.args.where as { status?: string };
    expect(where.status).toBe("OPEN");
    const src = getSourceWhere(where);
    expect(src).not.toBeNull();
    for (const s of src!.source.in) {
      expect(s.startsWith("in:")).toBe(true);
    }
  });

  it("getIndiaJournalStats only fans out an in:-prefixed source filter", async () => {
    const { client, calls } = buildStubPrisma({ findManyReturn: [] });
    await getIndiaJournalStats(client);
    const call = calls.find((c) => c.fn === "findMany");
    expect(call).toBeDefined();
    const where = getSourceWhere(call!.args.where);
    expect(where).not.toBeNull();
    for (const s of where!.source.in) {
      expect(s.startsWith("in:")).toBe(true);
    }
  });

  it("cancelIndiaOpenTrade refuses to mutate a crypto row even when called with its id", async () => {
    const { client, calls } = buildStubPrisma({
      findUniqueReturn: { status: "OPEN", source: "UT_SMC:5m" },
    });
    const result = await cancelIndiaOpenTrade("crypto-row-id", client);
    expect(result).toBeNull();
    // Should NOT have called update() — the row's source isn't `in:`.
    expect(calls.find((c) => c.fn === "update")).toBeUndefined();
  });

  it("setIndiaTradeNote refuses to mutate a crypto row even when called with its id", async () => {
    const { client, calls } = buildStubPrisma({
      findUniqueReturn: { source: "UT_SMC:5m" },
    });
    const result = await setIndiaTradeNote("crypto-row-id", "hello", client);
    expect(result).toBeNull();
    expect(calls.find((c) => c.fn === "update")).toBeUndefined();
  });
});
