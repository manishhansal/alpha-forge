/**
 * data-cli.ts — Data Foundation V5 operational CLI (§75/§76/§77/§78).
 *
 * Subcommands (wired to npm scripts):
 *   self-test  → configuration + auth + instrument resolution + historical +
 *                persistence, per provider (PASS/FAIL/NOT_CONFIGURED/UNSUPPORTED).
 *   readiness  → provider auth, intraday/daily/option coverage, gaps, freshness,
 *                provenance, Redis/Postgres, from the REAL DB.
 *   backfill   → capability-aware real backfill of a controlled universe.
 *   options    → real option-chain acquisition probe.
 *
 * All provider calls are REAL (worker-credential-loaded). No fabrication. No
 * secrets logged. Run with: npx tsx --conditions=react-server --env-file=.env.local scripts/data-cli.ts <cmd> [args]
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

type OHLCVLike = { time: number; open: number; high: number; low: number; close: number; volume?: number };

function safeErr(msg: string): string {
  return msg.replace(/[A-Za-z0-9._-]{40,}/g, "«redacted»").slice(0, 300);
}
function arg(name: string): string | undefined {
  const pfx = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pfx));
  if (hit) return hit.slice(pfx.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });

async function loadCreds() {
  const { loadWorkerCredentialsFromDb, workerCredentialStatus } = await import("../src/lib/market-data/worker-credentials");
  const res = await loadWorkerCredentialsFromDb({ prisma, userId: arg("userId") });
  return { res, status: workerCredentialStatus() };
}

// ── self-test ──────────────────────────────────────────────────────────────
async function selfTest() {
  const out: Record<string, unknown> = { command: "self-test", at: new Date().toISOString() };
  const { res } = await loadCreds();
  out.credentialLoad = { angel: res.angel, upstox: res.upstox, reason: res.reason ?? null };

  const { angel, resolveAngelWsSession } = await import("../src/services/india/angelone");
  const angelReport: Record<string, unknown> = {};
  if (!res.angel && !(process.env.SMARTAPI_API_KEY)) {
    angelReport.status = "NOT_CONFIGURED";
  } else {
    try {
      const ws = await resolveAngelWsSession();
      angelReport.authenticated = !!ws?.jwt;
      const candles = await angel.getHistorical({ symbol: "RELIANCE", interval: "5m", range: "5d" } as never, { allowFallback: false });
      angelReport.historical_5m_RELIANCE = candles.length;
      angelReport.status = ws?.jwt && candles.length > 0 ? "PASS" : ws?.jwt ? "AUTH_OK_NO_DATA" : "AUTH_FAILED";
    } catch (e) { angelReport.status = "FAIL"; angelReport.error = safeErr((e as Error).message); }
  }
  out.angel_one = angelReport;

  const { getWorkerUpstoxToken } = await import("../src/lib/market-data/worker-credentials");
  out.upstox = getWorkerUpstoxToken() || process.env.UPSTOX_ANALYTICS_TOKEN
    ? { status: "CONFIGURED", note: "token present; historical V3 path validated separately" }
    : { status: "NOT_CONFIGURED" };

  console.log(JSON.stringify(out, null, 2));
}

// ── readiness ────────────────────────────────────────────────────────────────
async function readiness() {
  const out: Record<string, unknown> = { command: "readiness", at: new Date().toISOString() };
  const { status } = await loadCreds();
  out.workerCredentials = status;

  const intervals = ["1m", "3m", "5m", "15m", "30m", "1h", "1d"];
  const byInterval = await prisma.candleBar.groupBy({ by: ["intervalStr"], _count: { _all: true }, _min: { time: true }, _max: { time: true } });
  out.candleCoverage = intervals.map((iv) => {
    const g = byInterval.find((x) => x.intervalStr === iv);
    return { interval: iv, rows: g?._count._all ?? 0, first: g?._min.time ? new Date(g._min.time * 1000).toISOString() : null, last: g?._max.time ? new Date(g._max.time * 1000).toISOString() : null };
  });
  const [gaps, incidents, obs, corr, oc] = await Promise.all([
    prisma.dataGap.count(), prisma.dataQualityIncident.count(), prisma.providerObservation.count(), prisma.dataCorrection.count(), prisma.optionChainSnapshot.count(),
  ]);
  out.durable = { dataGap: gaps, dataQualityIncident: incidents, providerObservation: obs, dataCorrection: corr, optionChainSnapshot: oc };

  // Infra.
  try { await prisma.$queryRaw`SELECT 1`; out.postgres = "OK"; } catch (e) { out.postgres = "FAIL: " + safeErr((e as Error).message); }
  try { const { getRedis } = await import("../worker/src/redis"); await getRedis().ping(); out.redis = "OK"; } catch (e) { out.redis = "FAIL: " + safeErr((e as Error).message); }

  console.log(JSON.stringify(out, null, 2));
}

// ── backfill ─────────────────────────────────────────────────────────────────
async function backfill() {
  const out: Record<string, unknown> = { command: "backfill", at: new Date().toISOString() };
  const symbols = (arg("symbols") ?? "RELIANCE,HDFCBANK,ICICIBANK,INFY,TCS,SBIN").split(",").map((s) => s.trim()).filter(Boolean);
  const intervals = (arg("intervals") ?? "5m,15m,30m,1h").split(",").map((s) => s.trim()).filter(Boolean);
  const range = arg("range") ?? "5d";
  out.params = { symbols, intervals, range };

  const { res } = await loadCreds();
  const { angel } = await import("../src/services/india/angelone");
  const { UpstoxProvider } = await import("../src/lib/market-data/providers/upstox");
  const upstox = new UpstoxProvider();
  const { persistCandles } = await import("../src/lib/market-data/services/candle-persist.service");
  const { datasetVersion } = await import("../src/lib/market-data/dataset-version");
  const { recordProviderObservation } = await import("../src/lib/market-data/services/provider-observation.service");
  const { providerSupportsHistoricalInterval } = await import("../src/lib/market-data/provider-selection");

  const INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);
  const fromIso = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const toIso = new Date().toISOString();

  async function fetchVia(provider: "angel_one" | "upstox", symbol: string, iv: string): Promise<OHLCVLike[]> {
    if (provider === "angel_one") {
      return (await angel.getHistorical({ symbol, interval: iv, range } as never, { allowFallback: false })) as OHLCVLike[];
    }
    // Upstox V3 (unlocks indices + full intraday set).
    return (await upstox.getHistoricalCandlesV3({ symbol, exchange: "NSE", interval: iv as never, from: fromIso, to: toIso } as never)) as OHLCVLike[];
  }

  const results: Array<Record<string, unknown>> = [];
  for (const symbol of symbols) {
    const isIndex = INDICES.has(symbol.toUpperCase());
    for (const iv of intervals) {
      // Capability-aware provider order: indices → Upstox first (Angel getCandleData
      // returns empty for index tokens); equities → Angel first, Upstox fallback.
      const providerOrder: Array<"angel_one" | "upstox"> = isIndex
        ? ["upstox", "angel_one"]
        : ["angel_one", "upstox"];
      const dvFor = (p: string) => datasetVersion(new Date().toISOString().slice(0, 10), { kind: "provider", provider: p });

      let done = false;
      for (const provider of providerOrder) {
        const available = provider === "angel_one" ? res.angel || !!process.env.SMARTAPI_API_KEY : true;
        if (!available) continue;
        if (provider === "angel_one" && !providerSupportsHistoricalInterval("angel_one", iv as never)) continue;
        const t0 = Date.now();
        try {
          const candles = await fetchVia(provider, symbol, iv);
          if (candles.length === 0) {
            await recordProviderObservation({ provider, instrumentId: symbol, dataType: "CANDLE", requestType: "backfill", interval: iv as never, outcome: "EMPTY", latencyMs: Date.now() - t0, recordCount: 0, prisma: prisma as never });
            continue; // try next provider (failover on empty)
          }
          const pr = await persistCandles(candles as never, symbol, "NSE", iv as never, { provider, datasetVersion: dvFor(provider), recordIncidentOnFailure: true, strictOhlc: true, prisma: prisma as never });
          await recordProviderObservation({ provider, instrumentId: symbol, dataType: "CANDLE", requestType: "backfill", interval: iv as never, outcome: "SUCCESS", latencyMs: Date.now() - t0, recordCount: candles.length, qualityStatus: "AVAILABLE", prisma: prisma as never });
          results.push({ symbol, interval: iv, provider, candles: candles.length, upserted: pr.upserted, errors: pr.errors });
          done = true;
          break;
        } catch (e) {
          await recordProviderObservation({ provider, instrumentId: symbol, dataType: "CANDLE", requestType: "backfill", interval: iv as never, outcome: "UNAVAILABLE", errorClass: safeErr((e as Error).message), latencyMs: Date.now() - t0, prisma: prisma as never });
        }
      }
      if (!done) results.push({ symbol, interval: iv, status: "NO_PROVIDER_RETURNED_DATA" });
    }
  }
  out.results = results;
  const totalUpserted = results.reduce((s, r) => s + (Number(r.upserted) || 0), 0);
  out.totalUpserted = totalUpserted;

  // Post-backfill DB snapshot.
  const byInterval = await prisma.candleBar.groupBy({ by: ["intervalStr"], _count: { _all: true } });
  out.dbAfter = byInterval.map((g) => ({ interval: g.intervalStr, rows: g._count._all }));
  console.log(JSON.stringify(out, null, 2));
}

// ── refresh-universe (V7 §3) ─────────────────────────────────────────────────
async function refreshUniverse() {
  const out: Record<string, unknown> = { command: "refresh-universe", at: new Date().toISOString() };
  await loadCreds();
  const { refreshInstrumentMaster } = await import(
    "../src/lib/market-data/services/instrument-master-universe.service"
  );
  const res = await refreshInstrumentMaster({ prisma: prisma as never });
  out.snapshot = res;
  console.log(JSON.stringify(out, null, 2));
}

// ── backfill-fno (V7 §5) — universe-scale, resumable, capability-aware ────────
async function backfillFno() {
  const out: Record<string, unknown> = { command: "backfill-fno", at: new Date().toISOString() };
  const { res } = await loadCreds();
  out.creds = { angel: res.angel, upstox: res.upstox };

  const intervals = (arg("intervals") ?? "1m,3m,5m,15m,30m,1h,1d")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Number(arg("limit") ?? "0"); // 0 = all symbols in universe
  const explicitSymbols = arg("symbols");
  const concurrency = Number(arg("concurrency") ?? "3");
  out.params = { intervals, limit, concurrency, universe: arg("universe") ?? "fno" };

  // Resolve the universe from the latest persisted instrument-master snapshot.
  let symbols: string[];
  if (explicitSymbols) {
    symbols = explicitSymbols.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const { getLatestUniverseUnderlyings } = await import(
      "../src/lib/market-data/services/instrument-master-universe.service"
    );
    const u = await getLatestUniverseUnderlyings({ prisma: prisma as never });
    out.snapshotVersion = u.snapshotVersion;
    symbols = u.symbols;
    if (symbols.length === 0) {
      out.error = "no instrument-master snapshot — run refresh-universe first";
      console.log(JSON.stringify(out, null, 2));
      return;
    }
  }
  if (limit > 0) symbols = symbols.slice(0, limit);
  out.symbolCount = symbols.length;

  const { getRedis } = await import("../worker/src/redis");
  const { runFnoUniverseBackfill, expandJobs } = await import(
    "../src/lib/market-data/services/fno-backfill-runner.service"
  );
  const jobs = expandJobs(symbols, intervals as never);
  const range = arg("range");
  const { results, totalBarsPersisted } = await runFnoUniverseBackfill(jobs, {
    redis: getRedis() as never,
    concurrency,
    ...(range ? { fromIstDate: range } : {}),
  });
  out.totalBarsPersisted = totalBarsPersisted;
  // Summarise per-interval to keep output bounded.
  const byInterval: Record<string, { bars: number; jobs: number; blocked: number }> = {};
  for (const r of results) {
    const b = (byInterval[r.interval] ??= { bars: 0, jobs: 0, blocked: 0 });
    b.bars += r.barsPersisted; b.jobs += 1;
    if (r.state === "BLOCKED" || r.state === "FAILED") b.blocked += 1;
  }
  out.byInterval = byInterval;
  console.log(JSON.stringify(out, null, 2));
}

// ── options-capture (V7 §9-12) — strike-level capture w/ expiry rollover ──────
async function optionsCapture() {
  const out: Record<string, unknown> = { command: "options-capture", at: new Date().toISOString() };
  const { res } = await loadCreds();
  out.creds = { angel: res.angel, upstox: res.upstox };

  const underlyings = (arg("underlyings") ?? "NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY")
    .split(",").map((s) => s.trim()).filter(Boolean);
  out.underlyings = underlyings;

  const { captureUnderlyingStrikes, defaultChainFetcher } = await import(
    "../src/lib/market-data/services/option-strike-capture.service"
  );
  const def = await defaultChainFetcher();
  const results = [];
  for (const u of underlyings) {
    const r = await captureUnderlyingStrikes(u, {
      prisma: prisma as never,
      fetcher: def.fetcher,
      providerLabel: def.providerLabel,
    });
    results.push(r);
  }
  out.results = results;
  const totalWritten = results.reduce((s, r) => s + r.strikesWritten, 0);
  out.totalStrikesWritten = totalWritten;

  // DB snapshot after.
  const oc = await prisma.optionChainStrike.groupBy({ by: ["underlying"], _count: { _all: true } });
  out.dbByUnderlying = oc.map((g) => ({ underlying: g.underlying, rows: g._count._all }));
  console.log(JSON.stringify(out, null, 2));
}

// ── readiness-matrix (V7 §26/§27/§33) ────────────────────────────────────────
async function readinessMatrix() {
  const out: Record<string, unknown> = { command: "readiness-matrix", at: new Date().toISOString() };
  await loadCreds();
  const symbols = (arg("symbols") ?? "NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,RELIANCE,HDFCBANK,TCS")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const { buildSignalDataSnapshot, buildFnoSignalReadinessMatrix, computeOverallDataStatus } = await import(
    "../src/lib/market-data/services/signal-data-snapshot.service"
  );
  const snapshot = await buildSignalDataSnapshot({ symbols, prisma: prisma as never });
  const matrix = buildFnoSignalReadinessMatrix(snapshot);
  const overall = computeOverallDataStatus(matrix);

  out.instrumentMasterVersion = snapshot.instrumentMasterVersion;
  out.snapshotTimestamp = new Date(snapshot.snapshotTimestamp).toISOString();
  out.overallDataStatus = overall.overallDataStatus;
  out.overallReason = overall.reason;
  out.perStrategyReadiness = overall.perStrategyReadiness;
  // Compact matrix: show state + reason per row.
  out.matrix = matrix.map((r) => ({ strategy: r.strategy, symbol: r.symbol, tf: r.timeframe, state: r.state, reason: r.reason }));
  console.log(JSON.stringify(out, null, 2));
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "self-test") await selfTest();
    else if (cmd === "readiness") await readiness();
    else if (cmd === "backfill") {
      // V7: `--universe=fno` routes to the universe-scale runner.
      if (arg("universe")) await backfillFno();
      else await backfill();
    }
    else if (cmd === "refresh-universe") await refreshUniverse();
    else if (cmd === "options-capture") await optionsCapture();
    else if (cmd === "readiness-matrix") await readinessMatrix();
    else console.log(JSON.stringify({ error: "unknown command", usage: "self-test | readiness | backfill | refresh-universe | options-capture | readiness-matrix" }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
  process.exit(0);
}
// Backfill/universe commands are long-running (rate-limited multi-symbol
// acquisition); everything else stays snappy.
const cmdName = process.argv[2];
const CLI_TIMEOUT_MS =
  cmdName === "backfill" || cmdName === "refresh-universe" || cmdName === "options-capture"
    ? 30 * 60_000
    : 180_000;
const to = setTimeout(() => { console.error(`CLI_TIMEOUT after ${CLI_TIMEOUT_MS}ms`); process.exit(2); }, CLI_TIMEOUT_MS);
to.unref?.();
main().catch((e) => { console.error("CLI_FAILED", safeErr((e as Error).message)); process.exit(1); });
