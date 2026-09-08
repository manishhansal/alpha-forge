/**
 * Real-provider E2E validation harness (read-only, market-data only).
 *
 * Reuses the EXISTING credential configuration (frontend Data Sources → API
 * Keys, stored encrypted in UserSetting.apiKeysEncrypted). It does NOT create a
 * new credential system and NEVER hard-codes or prints secrets.
 *
 * How it reuses existing credentials in a no-session (script) context:
 *   The production resolvers (resolveConfig / resolveReadToken) read env first,
 *   then fall back to the signed-in user's encrypted DB credentials via auth().
 *   A script has no auth() session, so we bridge the gap the intended way:
 *   we call the existing server-side readAngelCredentials()/readUpstoxCredentials()
 *   for the configured user and place the decrypted values into process.env
 *   IN-MEMORY ONLY (never written to disk or logs) so the unchanged env-first
 *   resolver path picks them up. This is exactly the same data the app uses.
 *
 * Safety:
 *   - Read-only. No orders, no trading endpoints, no account mutation.
 *   - Secrets are never logged; only presence/last-4 previews.
 *
 * Usage:
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/real-provider-validation.ts [--json]
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/real-provider-validation.ts --ws
 *
 * The `--ws` flag runs the LIVE WebSocket failover check (Angel WS → Upstox WS)
 * IN ADDITION to the REST checks. It opens each provider's own WebSocket via the
 * provider's `subscribe()`, waits for real ticks, then performs a SAFE,
 * SELF-INDUCED failover by calling the app's own teardown on the Angel socket
 * (NOT by abusing the provider) and confirms Upstox keeps delivering ticks.
 * Run this during market hours (09:15–15:30 IST) with a WS-enabled token.
 */

// NOTE: Run with `--conditions=react-server` so the transitive `server-only`
// imports (in api-keys.ts, prisma.ts, etc.) resolve to the empty shim, exactly
// like the worker process does. This is a server-side script, never bundled for
// the browser.
import { getPrisma } from "@/lib/prisma";
import { readAngelCredentials, readUpstoxCredentials } from "@/features/settings/api-keys";

// ── Structured, secret-safe logging ─────────────────────────────────────────

type Status = "PASS" | "FAIL" | "SKIP" | "NOT_CONFIGURED" | "INFO";

interface CheckResult {
  group: string;
  name: string;
  status: Status;
  detail?: string;
  data?: Record<string, unknown>;
}

const results: CheckResult[] = [];

function record(r: CheckResult): void {
  results.push(r);
  const tag = r.status.padEnd(14);
  const line = `[${tag}] ${r.group} › ${r.name}${r.detail ? ` — ${r.detail}` : ""}`;
  console.log(line);
}

/** Redact anything that looks secret before it can reach a log. */
function last4(s: string | undefined | null): string {
  if (!s) return "";
  const clean = s.replace(/\s+/gu, "");
  return clean.length <= 4 ? "****" : `…${clean.slice(-4)}`;
}

// ── Credential bridge (DB → in-memory env), reusing existing readers ─────────

/**
 * Load the configured user's Angel + Upstox credentials from the encrypted
 * store and inject them into process.env in-memory so the existing env-first
 * resolvers work without an auth() session. Returns which providers became
 * configured. Never logs secret values.
 */
async function bridgeCredentialsFromDb(): Promise<{
  angel: boolean;
  upstox: boolean;
  userId: string | null;
}> {
  const prisma = getPrisma();
  // Pick the single configured user (the one with stored API keys).
  const row = await prisma.userSetting.findFirst({
    where: { apiKeysEncrypted: { not: undefined } },
    select: { userId: true },
    orderBy: { updatedAt: "desc" },
  });
  const userId = row?.userId ?? null;
  if (!userId) return { angel: false, upstox: false, userId: null };

  let angel = false;
  let upstox = false;

  // Angel One — only inject when env is not already set (env wins in prod too).
  if (!process.env.SMARTAPI_API_KEY) {
    const creds = await readAngelCredentials(userId);
    if (creds) {
      process.env.SMARTAPI_API_KEY = creds.apiKey;
      process.env.SMARTAPI_CLIENT_CODE = creds.clientCode;
      process.env.SMARTAPI_PIN = creds.pin;
      process.env.SMARTAPI_TOTP_SECRET = creds.totpSecret;
      angel = true;
      record({
        group: "credentials",
        name: "Angel One credentials loaded from Data Sources (DB)",
        status: "PASS",
        detail: `apiKey ${last4(creds.apiKey)} clientCode ${last4(creds.clientCode)}`,
      });
    }
  } else {
    angel = true;
    record({ group: "credentials", name: "Angel One credentials present in env", status: "PASS" });
  }

  if (!process.env.UPSTOX_ANALYTICS_TOKEN && !process.env.UPSTOX_ACCESS_TOKEN) {
    const creds = await readUpstoxCredentials(userId);
    if (creds?.analyticsToken) {
      process.env.UPSTOX_ANALYTICS_TOKEN = creds.analyticsToken;
      upstox = true;
      record({
        group: "credentials",
        name: "Upstox Analytics Token loaded from Data Sources (DB)",
        status: "PASS",
        detail: `token ${last4(creds.analyticsToken)}`,
      });
    }
  } else {
    upstox = true;
    record({ group: "credentials", name: "Upstox token present in env", status: "PASS" });
  }

  if (!angel) {
    record({ group: "credentials", name: "Angel One", status: "NOT_CONFIGURED" });
  }
  if (!upstox) {
    record({ group: "credentials", name: "Upstox", status: "NOT_CONFIGURED" });
  }

  return { angel, upstox, userId };
}

// ── Instruments to validate (today) ──────────────────────────────────────────

const INDICES = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];
const EQUITIES = ["RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "INFY", "TCS"];
const YAHOO_INDEX = ["^NSEI", "^NSEBANK"];

// ── Connectivity + data checks ───────────────────────────────────────────────

async function checkAngel(configured: boolean): Promise<void> {
  const group = "angel_one";
  if (!configured) {
    record({ group, name: "connectivity", status: "NOT_CONFIGURED" });
    return;
  }
  const { angel, isAngelConfigured } = await import("@/services/india/angelone");

  record({ group, name: "isAngelConfigured()", status: isAngelConfigured() ? "PASS" : "FAIL" });

  // Auth + historical in one shot (mirrors verify-angelone.ts).
  try {
    const t0 = Date.now();
    const candles = await angel.getHistorical(
      { symbol: "RELIANCE", interval: "5m", range: "5d" },
      { allowFallback: false },
    );
    const ms = Date.now() - t0;
    if (candles.length > 0) {
      const last = candles[candles.length - 1]!;
      record({
        group,
        name: "auth + getHistorical(RELIANCE 5m)",
        status: "PASS",
        detail: `${candles.length} candles, ${ms}ms`,
        data: { lastClose: last.close, lastTime: new Date(last.time * 1000).toISOString() },
      });
    } else {
      record({
        group,
        name: "auth + getHistorical(RELIANCE 5m)",
        status: "FAIL",
        detail: "0 candles (login may have succeeded but no data — market closed?)",
      });
    }
  } catch (e) {
    record({
      group,
      name: "auth + getHistorical(RELIANCE 5m)",
      status: "FAIL",
      detail: (e as Error).message,
    });
  }

  // Live quotes (strict — no Yahoo backfill so we see the real Angel result).
  try {
    const t0 = Date.now();
    const quotes = await angel.getQuotes([...INDICES.slice(0, 2), ...EQUITIES.slice(0, 3)], {
      allowFallback: false,
    });
    const ms = Date.now() - t0;
    const withPrice = quotes.filter((q) => q.price != null).length;
    record({
      group,
      name: "getQuotes(strict)",
      status: withPrice > 0 ? "PASS" : "FAIL",
      detail: `${withPrice}/${quotes.length} priced, ${ms}ms`,
      data: { sample: quotes.slice(0, 2).map((q) => ({ s: q.symbol, price: q.price, src: q.source })) },
    });
  } catch (e) {
    record({ group, name: "getQuotes(strict)", status: "FAIL", detail: (e as Error).message });
  }

  // Option chain (real current expiry, resolved by the adapter).
  try {
    const t0 = Date.now();
    const chain = await angel.getOptionChain("NIFTY");
    const ms = Date.now() - t0;
    record({
      group,
      name: "getOptionChain(NIFTY)",
      status: chain.rows.length > 0 ? "PASS" : "FAIL",
      detail: `${chain.rows.length} strikes, expiry ${chain.expiry}, ${ms}ms`,
    });
  } catch (e) {
    record({ group, name: "getOptionChain(NIFTY)", status: "FAIL", detail: (e as Error).message });
  }
}

async function checkUpstox(configured: boolean): Promise<void> {
  const group = "upstox";
  if (!configured) {
    record({ group, name: "connectivity", status: "NOT_CONFIGURED" });
    return;
  }
  const upstox = await import("@/lib/market-data/providers/upstox");
  const provider = new upstox.UpstoxProvider();

  record({ group, name: "isUpstoxConfigured()", status: upstox.isUpstoxConfigured() ? "PASS" : "FAIL" });

  try {
    const t0 = Date.now();
    const quotes = await provider.getQuotes([...INDICES.slice(0, 2), ...EQUITIES.slice(0, 3)]);
    const ms = Date.now() - t0;
    const withPrice = quotes.filter((q) => q && q.ltp != null).length;
    record({
      group,
      name: "getQuotes",
      status: withPrice > 0 ? "PASS" : "FAIL",
      detail: `${withPrice}/${quotes.length} priced, ${ms}ms`,
      data: { sample: quotes.slice(0, 2).map((q) => (q ? { s: q.symbol, ltp: q.ltp, oi: q.oi } : null)) },
    });
  } catch (e) {
    record({ group, name: "getQuotes", status: "FAIL", detail: (e as Error).message });
  }

  try {
    const t0 = Date.now();
    const candles = await provider.getHistoricalCandles({
      symbol: "RELIANCE",
      exchange: "NSE",
      interval: "1d",
      from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
    });
    const ms = Date.now() - t0;
    record({
      group,
      name: "getHistoricalCandles(RELIANCE 1d)",
      status: candles.length > 0 ? "PASS" : "FAIL",
      detail: `${candles.length} candles, ${ms}ms`,
    });
  } catch (e) {
    record({ group, name: "getHistoricalCandles(RELIANCE 1d)", status: "FAIL", detail: (e as Error).message });
  }
}

async function checkYahoo(): Promise<void> {
  const group = "yahoo";
  const { yahoo } = await import("@/services/india/yahoo");
  try {
    const t0 = Date.now();
    const candles = await yahoo.getHistorical({ symbol: "^NSEI", interval: "1d", range: "5d" });
    const ms = Date.now() - t0;
    record({
      group,
      name: "getHistorical(^NSEI 1d)",
      status: candles.length > 0 ? "PASS" : "FAIL",
      detail: `${candles.length} candles, ${ms}ms`,
    });
  } catch (e) {
    record({ group, name: "getHistorical(^NSEI 1d)", status: "FAIL", detail: (e as Error).message });
  }
}

// ── Cross-provider reconciliation (Angel vs Upstox) ──────────────────────────

async function reconcile(angelOk: boolean, upstoxOk: boolean): Promise<void> {
  const group = "reconciliation";
  if (!angelOk || !upstoxOk) {
    record({ group, name: "cross-provider", status: "SKIP", detail: "needs both Angel + Upstox" });
    return;
  }
  const { angel } = await import("@/services/india/angelone");
  const upstoxMod = await import("@/lib/market-data/providers/upstox");
  const uprov = new upstoxMod.UpstoxProvider();
  const recon = await import("@/lib/market-data");

  const syms = [...INDICES.slice(0, 2), ...EQUITIES.slice(0, 2)];
  try {
    const [aq, uq] = await Promise.all([
      angel.getQuotes(syms, { allowFallback: false }),
      uprov.getQuotes(syms),
    ]);
    let compared = 0;
    for (let i = 0; i < syms.length; i++) {
      const a = aq[i];
      const u = uq[i];
      if (!a || a.price == null || !u || u.ltp == null) continue;
      const category = INDICES.includes(syms[i]!) ? "INDEX" : "STOCK";
      const report = recon.reconcileQuotes(
        syms[i]!,
        { provider: "angel_one", ltp: a.price },
        { provider: "upstox", ltp: u.ltp },
        category as "INDEX" | "STOCK",
      );
      compared += 1;
      record({
        group,
        name: `${syms[i]} Angel vs Upstox`,
        status: report.tier === "INVALID" ? "FAIL" : "PASS",
        detail: `tier=${report.tier} angel=${a.price} upstox=${u.ltp}`,
      });
    }
    if (compared === 0) {
      record({ group, name: "cross-provider", status: "SKIP", detail: "no overlapping priced symbols (market closed)" });
    }
  } catch (e) {
    record({ group, name: "cross-provider", status: "FAIL", detail: (e as Error).message });
  }
}

// ── Historical multi-interval + OHLC integrity (Angel) ──────────────────────

async function checkHistoricalIntegrity(angelOk: boolean): Promise<void> {
  const group = "historical";
  if (!angelOk) {
    record({ group, name: "multi-interval", status: "NOT_CONFIGURED" });
    return;
  }
  const { angel } = await import("@/services/india/angelone");
  const recon = await import("@/lib/market-data");

  for (const interval of ["5m", "15m", "1h", "1d"] as const) {
    try {
      const candles = await angel.getHistorical(
        { symbol: "RELIANCE", interval, range: interval === "1d" ? "1mo" : "5d" },
        { allowFallback: false },
      );
      if (candles.length === 0) {
        record({ group, name: `RELIANCE ${interval}`, status: "FAIL", detail: "0 candles" });
        continue;
      }
      // OHLC structural validation on every bar + duplicate-timestamp detection.
      const seen = new Set<number>();
      let ohlcErrors = 0;
      let dupes = 0;
      let outOfOrder = 0;
      let prevTime = 0;
      for (const c of candles) {
        const v = recon.validateOHLC(
          { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 },
        );
        if (!v.valid) ohlcErrors += 1;
        if (seen.has(c.time)) dupes += 1;
        seen.add(c.time);
        if (c.time < prevTime) outOfOrder += 1;
        prevTime = c.time;
      }
      const ok = ohlcErrors === 0 && dupes === 0 && outOfOrder === 0;
      record({
        group,
        name: `RELIANCE ${interval}`,
        status: ok ? "PASS" : "FAIL",
        detail: `${candles.length} bars, ohlcErrors=${ohlcErrors} dupes=${dupes} outOfOrder=${outOfOrder}`,
      });
    } catch (e) {
      record({ group, name: `RELIANCE ${interval}`, status: "FAIL", detail: (e as Error).message });
    }
  }
}

// ── Historical production-path failover (Angel 403 → fallback) ──────────────

async function checkHistoricalFailover(angelOk: boolean, upstoxOk: boolean): Promise<void> {
  const group = "historical_failover";
  if (!angelOk && !upstoxOk) {
    record({ group, name: "production path", status: "NOT_CONFIGURED" });
    return;
  }
  // The strict (allowFallback:false) Angel calls above isolate provider failures
  // for diagnosis. This check exercises the PRODUCTION path where fallback is
  // enabled: even if Angel historical is 403-blocked, the chain must still return
  // candles from Upstox / Yahoo. Uses a daily bar (supported by Upstox v2).
  const { angel } = await import("@/services/india/angelone");
  try {
    const candles = await angel.getHistorical(
      { symbol: "RELIANCE", interval: "1d", range: "1mo" },
      { allowFallback: true },
    );
    record({
      group,
      name: "RELIANCE 1d with fallback enabled (survives Angel 403)",
      status: candles.length > 0 ? "PASS" : "FAIL",
      detail: `${candles.length} candles via production fallback chain`,
    });
  } catch (e) {
    record({ group, name: "production path", status: "FAIL", detail: (e as Error).message });
  }
}

// ── OI correctness + semantic guard (Task 7) ────────────────────────────────

async function checkOI(angelOk: boolean): Promise<void> {
  const group = "oi_correctness";
  if (!angelOk) {
    record({ group, name: "option-chain OI", status: "NOT_CONFIGURED" });
    return;
  }
  const { angel } = await import("@/services/india/angelone");
  try {
    const chain = await angel.getOptionChain("NIFTY");
    let oiNonNeg = true;
    let oiPresent = 0;
    let suspiciouslyLarge = 0; // OI that looks like it could be traded-value
    for (const row of chain.rows) {
      for (const leg of [row.ce, row.pe]) {
        if (!leg) continue;
        if (typeof leg.oi === "number") {
          oiPresent += 1;
          if (leg.oi < 0) oiNonNeg = false;
          // Traded value (INR) for a NIFTY option strike would be astronomically
          // larger than contract OI; flag anything > 1e10 as a possible mismap.
          if (leg.oi > 1e10) suspiciouslyLarge += 1;
        }
      }
    }
    record({
      group,
      name: "NIFTY option OI is contract-count (not traded value)",
      status: oiNonNeg && suspiciouslyLarge === 0 ? "PASS" : "FAIL",
      detail: `${oiPresent} legs with OI, nonNeg=${oiNonNeg}, suspiciouslyLarge=${suspiciouslyLarge}`,
    });
  } catch (e) {
    record({ group, name: "NIFTY option OI", status: "FAIL", detail: (e as Error).message });
  }
}

// ── Deep option-chain field validation (Task 8) ─────────────────────────────

async function checkOptionChainFields(angelOk: boolean): Promise<void> {
  const group = "option_chain";
  if (!angelOk) {
    record({ group, name: "fields", status: "NOT_CONFIGURED" });
    return;
  }
  const { angel } = await import("@/services/india/angelone");
  try {
    const chain = await angel.getOptionChain("NIFTY");
    // Expiry sanity: selected expiry must be today or future, never past.
    const expMs = Date.parse(chain.expiry);
    const expiryValid = Number.isFinite(expMs) && expMs >= Date.now() - 86_400_000;
    record({
      group,
      name: "expiry not in the past",
      status: expiryValid ? "PASS" : "FAIL",
      detail: `expiry=${chain.expiry}`,
    });
    // Strike/optionType structural mapping.
    let badStrike = 0;
    let badType = 0;
    for (const row of chain.rows) {
      if (!(row.strike > 0)) badStrike += 1;
      if (row.ce && row.ce.type !== "CE") badType += 1;
      if (row.pe && row.pe.type !== "PE") badType += 1;
    }
    record({
      group,
      name: "strike>0 and CE/PE mapping",
      status: badStrike === 0 && badType === 0 ? "PASS" : "FAIL",
      detail: `${chain.rows.length} rows, badStrike=${badStrike} badType=${badType}`,
    });
    // Analytics presence (PCR etc.) — informational.
    record({
      group,
      name: "analytics computed",
      status: "INFO",
      detail: `pcrOi=${chain.analytics?.pcrOi ?? "n/a"} maxPain=${chain.analytics?.maxPain ?? "n/a"}`,
    });
  } catch (e) {
    record({ group, name: "fields", status: "FAIL", detail: (e as Error).message });
  }
}

// ── Instrument cross-mapping (Task 9) ────────────────────────────────────────

async function checkInstrumentMapping(upstoxOk: boolean): Promise<void> {
  const group = "instrument_mapping";
  // Upstox ISIN key resolution (the fixed path).
  if (upstoxOk) {
    const { resolveUpstoxInstrumentKey } = await import("@/lib/market-data/providers/upstox");
    for (const [sym, wantPrefix] of [
      ["RELIANCE", "NSE_EQ|INE"],
      ["HDFCBANK", "NSE_EQ|INE"],
      ["NIFTY", "NSE_INDEX|"],
      ["BANKNIFTY", "NSE_INDEX|"],
    ] as const) {
      try {
        const key = await resolveUpstoxInstrumentKey(sym, "NSE");
        record({
          group,
          name: `upstox key ${sym}`,
          status: key.startsWith(wantPrefix) ? "PASS" : "FAIL",
          detail: key,
        });
      } catch (e) {
        record({ group, name: `upstox key ${sym}`, status: "FAIL", detail: (e as Error).message });
      }
    }
  } else {
    record({ group, name: "upstox key mapping", status: "NOT_CONFIGURED" });
  }
}

// ── Cache + single-flight (Task 11) ──────────────────────────────────────────

async function checkCacheAndCoalescing(upstoxOk: boolean): Promise<void> {
  const group = "cache";
  if (!upstoxOk) {
    record({ group, name: "single-flight", status: "NOT_CONFIGURED" });
    return;
  }
  // Count real fetches to Upstox during a coalesced burst by spying on fetch.
  const originalFetch = globalThis.fetch;
  let upstoxCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.upstox.com/v2/market-quote")) upstoxCalls += 1;
    return originalFetch(input as never, init as never);
  }) as typeof fetch;

  try {
    const upstoxMod = await import("@/lib/market-data/providers/upstox");
    const prov = new upstoxMod.UpstoxProvider();
    // Warm once so the instrument master + first result is cached.
    await prov.getQuotes(["RELIANCE"]);
    const callsAfterWarm = upstoxCalls;
    // 20 concurrent identical requests should coalesce to (ideally) 0 extra
    // provider calls within the cache TTL window.
    await Promise.all(Array.from({ length: 20 }, () => prov.getQuotes(["RELIANCE"])));
    const extraCalls = upstoxCalls - callsAfterWarm;
    record({
      group,
      name: "20 concurrent identical quotes → coalesced",
      status: extraCalls <= 1 ? "PASS" : "FAIL",
      detail: `extra provider calls during burst = ${extraCalls} (want ≤1)`,
    });
  } catch (e) {
    record({ group, name: "single-flight", status: "FAIL", detail: (e as Error).message });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── Resilience via fault injection (Task 10) — no provider abuse ─────────────

async function checkResilience(): Promise<void> {
  const group = "resilience";
  const health = await import("@/lib/market-data/health");
  const { withFailover } = await import("@/lib/market-data/failover");
  const { MarketDataError } = await import("@/lib/market-data/types");

  // Reset provider health so this is deterministic regardless of prior calls.
  health.resetAllHealth();

  // Fault-inject a 403 on a stub "angel_one" and confirm no retry storm + failover.
  let angelCalls = 0;
  let upstoxCalls = 0;
  const mkEntry = (id: "angel_one" | "upstox", fail: boolean) => ({
    provider: {
      id,
      async getLatestQuote() {
        if (id === "angel_one") angelCalls += 1;
        else upstoxCalls += 1;
        if (fail) throw new MarketDataError(`HTTP 403`, id, "AUTHORIZATION_FAILURE", 403);
        return {
          symbol: "NIFTY", token: null, exchange: "NSE" as const, name: null, ltp: 100,
          change: null, changePct: null, prevClose: null, open: null, high: null, low: null,
          volume: null, oi: null, weekHigh52: null, weekLow52: null, upperCircuit: null,
          lowerCircuit: null, totalBuyQty: null, totalSellQty: null, lastTradeTime: null,
          provider: id, fetchedAt: new Date().toISOString(),
        };
      },
    },
    // minimal stubs for the rest of the interface
    capabilities: { historicalCandles: true, liveQuotes: true, webSocket: true, optionChain: true, instrumentMaster: true, intradayCandles: true, fno: true },
    priority: id === "angel_one" ? 1 : 2,
    enabled: true,
  }) as unknown as Parameters<typeof withFailover>[0][number];

  try {
    const res = await withFailover(
      [mkEntry("angel_one", true), mkEntry("upstox", false)],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.getLatestQuote("NIFTY"),
      "getLatestQuote",
      "liveQuotes",
    );
    record({
      group,
      name: "403 → no retry storm, fail over to Upstox",
      status: (res as { provider?: string })?.provider === "upstox" && angelCalls === 1 ? "PASS" : "FAIL",
      detail: `angelCalls=${angelCalls} (want 1), servedBy=${(res as { provider?: string })?.provider}`,
    });
  } catch (e) {
    record({ group, name: "403 failover", status: "FAIL", detail: (e as Error).message });
  }

  // Circuit-open → no hammering: drive angel_one circuit open, then confirm it
  // is skipped entirely (0 calls) while Upstox serves.
  health.resetAllHealth();
  for (let i = 0; i < 3; i++) health.recordFailure("angel_one", "hard_block");
  const circuitOpen = health.isCircuitOpen("angel_one");
  angelCalls = 0;
  upstoxCalls = 0;
  try {
    const res = await withFailover(
      [mkEntry("angel_one", false), mkEntry("upstox", false)],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.getLatestQuote("NIFTY"),
      "getLatestQuote",
      "liveQuotes",
    );
    record({
      group,
      name: "circuit OPEN → Angel skipped (0 calls), Upstox serves",
      status: circuitOpen && angelCalls === 0 && (res as { provider?: string })?.provider === "upstox" ? "PASS" : "FAIL",
      detail: `circuitOpen=${circuitOpen} angelCalls=${angelCalls} servedBy=${(res as { provider?: string })?.provider}`,
    });
  } catch (e) {
    record({ group, name: "circuit-open no-hammer", status: "FAIL", detail: (e as Error).message });
  } finally {
    health.resetAllHealth();
  }
}

// ── LIVE WebSocket failover (opt-in via --ws) ────────────────────────────────

/**
 * Live WebSocket failover check. Opens Angel's and Upstox's own WebSockets via
 * each provider's `subscribe()`, waits for real ticks, then performs a SAFE,
 * self-induced Angel failover (calls the provider's own unsubscribe teardown —
 * NOT any provider-abusing action) and confirms Upstox keeps delivering ticks.
 *
 * Honest by construction: if a provider yields no ticks within the window
 * (auth/entitlement/market-closed), it reports SKIP/NOT_CONFIGURED with the
 * reason rather than a false PASS. Never places orders; read-only feed only.
 */
async function checkWebSocketFailover(angelOk: boolean, upstoxOk: boolean): Promise<void> {
  const group = "websocket";
  const WAIT_MS = 20_000; // how long to wait for the first real tick per provider

  // NIFTY / BANKNIFTY index tokens. Angel resolves symbols via its instrument
  // master; Upstox uses the instrument key as the "token".
  const angelReq = {
    tokens: [
      { token: "26000", exchange: "NSE" as const }, // NIFTY 50 index
      { token: "26009", exchange: "NSE" as const }, // NIFTY BANK index
    ],
    mode: "ltp" as const,
  };
  const upstoxReq = {
    tokens: [
      { token: "NSE_INDEX|Nifty 50", exchange: "NSE" as const },
      { token: "NSE_INDEX|Nifty Bank", exchange: "NSE" as const },
    ],
    mode: "ltp" as const,
  };

  /** Subscribe to a provider and resolve with the tick count seen in `waitMs`. */
  async function countTicks(
    provider: { subscribe: (req: any, onTick: (t: any) => void, onErr?: (e: unknown) => void) => () => void },
    req: any,
    waitMs: number,
  ): Promise<{ ticks: number; firstTickMs: number | null; teardown: () => void; lastErr: string | null }> {
    let ticks = 0;
    let firstTickMs: number | null = null;
    let lastErr: string | null = null;
    const start = Date.now();
    let teardown: () => void = () => {};
    teardown = provider.subscribe(
      req,
      () => {
        ticks += 1;
        if (firstTickMs == null) firstTickMs = Date.now() - start;
      },
      (e: unknown) => {
        lastErr = e instanceof Error ? e.message : String(e);
      },
    );
    await new Promise((r) => setTimeout(r, waitMs));
    return { ticks, firstTickMs, teardown, lastErr };
  }

  if (!angelOk && !upstoxOk) {
    record({ group, name: "live failover", status: "NOT_CONFIGURED" });
    return;
  }

  // 1. Angel WS — measure first-tick latency + rate.
  let angelTeardown: () => void = () => {};
  let angelHadTicks = false;
  if (angelOk) {
    try {
      const { AngelOneProvider } = await import("@/lib/market-data/providers/angel-one");
      const angelProv = new AngelOneProvider();
      const res = await countTicks(angelProv, angelReq, WAIT_MS);
      angelTeardown = res.teardown;
      angelHadTicks = res.ticks > 0;
      record({
        group,
        name: "Angel WS live ticks",
        status: res.ticks > 0 ? "PASS" : "SKIP",
        detail:
          res.ticks > 0
            ? `${res.ticks} ticks, firstTick=${res.firstTickMs}ms, rate=${(res.ticks / (WAIT_MS / 1000)).toFixed(1)}/s`
            : `0 ticks in ${WAIT_MS}ms${res.lastErr ? ` (err: ${res.lastErr})` : " — market closed or WS entitlement missing"}`,
      });
    } catch (e) {
      record({ group, name: "Angel WS", status: "FAIL", detail: (e as Error).message });
    }
  } else {
    record({ group, name: "Angel WS", status: "NOT_CONFIGURED" });
  }

  // 2. Upstox WS — must be up BEFORE we tear down Angel (hot standby).
  let upstoxTeardown: () => void = () => {};
  let upstoxTicksBefore = 0;
  const upstoxTickTimes: number[] = [];
  if (upstoxOk) {
    try {
      const upstoxMod = await import("@/lib/market-data/providers/upstox");
      const upstoxProv = new upstoxMod.UpstoxProvider();
      upstoxTeardown = upstoxProv.subscribe(
        upstoxReq,
        () => {
          upstoxTicksBefore += 1;
          upstoxTickTimes.push(Date.now());
        },
        () => {},
      );
      await new Promise((r) => setTimeout(r, WAIT_MS));
      record({
        group,
        name: "Upstox WS live ticks (hot standby)",
        status: upstoxTicksBefore > 0 ? "PASS" : "SKIP",
        detail:
          upstoxTicksBefore > 0
            ? `${upstoxTicksBefore} ticks in ${WAIT_MS}ms`
            : `0 ticks — market closed or WS entitlement missing`,
      });
    } catch (e) {
      record({ group, name: "Upstox WS", status: "FAIL", detail: (e as Error).message });
    }
  } else {
    record({ group, name: "Upstox WS", status: "NOT_CONFIGURED" });
  }

  // 3. SAFE self-induced failover: tear down Angel, confirm Upstox keeps ticking.
  if (angelHadTicks && upstoxTicksBefore > 0) {
    const failoverAt = Date.now();
    angelTeardown(); // app's own teardown — not a provider-abusing action
    const upstoxCountAtFailover = upstoxTicksBefore;
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const upstoxAfter = upstoxTickTimes.filter((t) => t > failoverAt).length;
    // First Upstox tick strictly after the Angel teardown = failover latency proxy.
    const firstAfter = upstoxTickTimes.find((t) => t > failoverAt);
    record({
      group,
      name: "Angel WS down → Upstox continues (self-induced)",
      status: upstoxAfter > 0 ? "PASS" : "FAIL",
      detail: `Upstox ticks after Angel teardown=${upstoxAfter}, firstAfter=${firstAfter ? firstAfter - failoverAt : "n/a"}ms (upstoxTotalBefore=${upstoxCountAtFailover})`,
    });
  } else {
    record({
      group,
      name: "Angel WS down → Upstox continues",
      status: "SKIP",
      detail: `needs live ticks from BOTH (angelTicks=${angelHadTicks}, upstoxTicks=${upstoxTicksBefore}); likely market closed or WS entitlement missing`,
    });
  }

  // Cleanup — always tear down both feeds.
  try { angelTeardown(); } catch { /* ignore */ }
  try { upstoxTeardown(); } catch { /* ignore */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const jsonOut = process.argv.includes("--json");
  const runWs = process.argv.includes("--ws");
  console.log("=== AlphaForge Real-Provider Validation (read-only) ===");
  console.log(`Started: ${new Date().toISOString()}  (IST ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })})\n`);

  const bridged = await bridgeCredentialsFromDb();
  record({
    group: "credentials",
    name: "configured user resolved",
    status: bridged.userId ? "PASS" : "FAIL",
    detail: bridged.userId ? `user ${bridged.userId.slice(0, 8)}…` : "no UserSetting with API keys",
  });

  await checkAngel(bridged.angel);
  await checkUpstox(bridged.upstox);
  await checkYahoo();
  await reconcile(bridged.angel, bridged.upstox);
  await checkHistoricalIntegrity(bridged.angel);
  await checkHistoricalFailover(bridged.angel, bridged.upstox);
  await checkOI(bridged.angel);
  await checkOptionChainFields(bridged.angel);
  await checkInstrumentMapping(bridged.upstox);
  await checkCacheAndCoalescing(bridged.upstox);
  await checkResilience();
  if (runWs) {
    console.log("\n--- Live WebSocket failover (--ws) — this takes ~60s ---");
    await checkWebSocketFailover(bridged.angel, bridged.upstox);
  }

  // Summary
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n=== Summary: ${JSON.stringify(counts)} ===`);

  if (jsonOut) {
    console.log("\n---JSON---");
    console.log(JSON.stringify(results, null, 2));
  }

  try {
    await getPrisma().$disconnect();
  } catch {
    /* ignore */
  }
}

main()
  .then(() => {
    // WebSocket connections / timers can keep the event loop alive after the
    // report is printed; exit explicitly so `--ws` runs terminate cleanly.
    process.exit(0);
  })
  .catch((e) => {
    console.error("[real-provider-validation] fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
