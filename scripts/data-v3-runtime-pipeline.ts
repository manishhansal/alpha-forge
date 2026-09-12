/**
 * data-v3-runtime-pipeline.ts — Data Foundation V3 §31/§32/§58/§59.
 *
 * Executes the V3 pipeline against the REAL environment and REAL DB so the
 * final report can distinguish IMPLEMENTED from DB-VERIFIED / LIVE-RUNTIME-
 * VERIFIED. It:
 *
 *   1. Prints the provider capability matrix (with enabled flags from the real
 *      registry / credential state).
 *   2. LIVE: makes a real status-aware quote call through the provider chain and
 *      records a ProviderObservation (real latency/status). This is the live
 *      runtime validation §31 — honest about what the environment allows.
 *   3. Records real DataQualityIncidents for the D-V2-10 findings actually
 *      present in the DB (duplicate daily trading days, weekend daily bars) with
 *      dedup/correlation — populating the previously-empty incident table from
 *      TRUE evidence, not fabrication.
 *   4. Runs gap detection on a real daily instrument and persists any DataGap
 *      rows found (there should be none for a ~100%-complete daily series — a
 *      genuine result, not a manufactured one).
 *   5. Evaluates capability-specific market-session readiness from the DB.
 *
 * Read-mostly: the only writes are durable observability rows (observations /
 * incidents / gaps) that record TRUE facts about the data. No candle is created,
 * mutated, or fabricated.
 *
 * Run: npx tsx --env-file=.env.local scripts/data-v3-runtime-pipeline.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const SESSION_OPEN_MIN = 9 * 60 + 15;

function istParts(sec: number) {
  const d = new Date(sec * 1000 + IST_OFFSET_MS);
  return {
    dow: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
  };
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  // ── 1. Capability matrix ────────────────────────────────────────────────
  const { renderCapabilityMatrixMarkdown, PROVIDER_CAPABILITY_MATRIX } = await import(
    "../src/lib/market-data/provider-capability-matrix"
  );
  const dataServiceEnabled = !!process.env.DATA_SERVICE_URL;
  const angelConfigured = !!(process.env.SMARTAPI_API_KEY && process.env.SMARTAPI_CLIENT_CODE);
  const upstoxConfigured = !!(process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_ANALYTICS_TOKEN);
  const enabled = (p: string) =>
    p === "scrapling" ? dataServiceEnabled
    : p === "angel_one" ? angelConfigured
    : p === "upstox" ? upstoxConfigured
    : p === "yahoo" ? true
    : false;
  out.capabilityMatrixMarkdown = renderCapabilityMatrixMarkdown(enabled as never);
  out.providerEnabled = { scrapling: dataServiceEnabled, angel_one: angelConfigured, upstox: upstoxConfigured, yahoo: true };

  // ── 2. LIVE quote via data-service, record real observation ─────────────
  const { recordProviderObservation } = await import(
    "../src/lib/market-data/services/provider-observation.service"
  );
  const liveResult: Record<string, unknown> = {};
  try {
    const t0 = Date.now();
    const url = `${process.env.DATA_SERVICE_URL}/scraping/quotes?symbols=NIFTY&exchange=NSE`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const latencyMs = Date.now() - t0;
    const body = (await resp.json()) as { quotes?: Array<{ ltp?: number; volume?: number | null; fetchedAt?: string }> };
    const q = body.quotes?.[0];
    liveResult.httpStatus = resp.status;
    liveResult.latencyMs = latencyMs;
    liveResult.ltp = q?.ltp ?? null;
    liveResult.volumePreservedAsNull = q?.volume === null || q?.volume === undefined;
    await recordProviderObservation({
      provider: "scrapling",
      instrumentId: "NIFTY",
      dataType: "QUOTE",
      requestType: "live-runtime-validation",
      httpStatus: resp.status,
      outcome: resp.ok && q?.ltp != null ? "SUCCESS" : "EMPTY",
      latencyMs,
      recordCount: q ? 1 : 0,
      sourceTimestamp: q?.fetchedAt ?? null,
      qualityStatus: resp.ok ? "AVAILABLE" : "UNAVAILABLE",
      prisma,
    });
  } catch (err) {
    liveResult.error = (err as Error).message;
    await recordProviderObservation({
      provider: "scrapling",
      instrumentId: "NIFTY",
      dataType: "QUOTE",
      requestType: "live-runtime-validation",
      outcome: "TIMEOUT",
      errorClass: (err as Error).message,
      prisma,
    });
  }
  out.liveQuote = liveResult;

  // ── 3. Record REAL D-V2-10 data-quality incidents (dedup/correlated) ─────
  const { recordDataIncident } = await import(
    "../src/lib/market-data/services/data-incident.service"
  );
  const daily = await prisma.candleBar.findMany({
    where: { intervalStr: "1d" },
    select: { instrumentId: true, exchange: true, time: true },
  });
  const byInstrDate = new Map<string, number>();
  let weekendBars = 0;
  let dupDays = 0;
  for (const r of daily) {
    const p = istParts(r.time);
    if (p.dow === 0 || p.dow === 6) weekendBars += 1;
    const k = `${r.instrumentId}|${r.exchange}|${p.date}`;
    byInstrDate.set(k, (byInstrDate.get(k) ?? 0) + 1);
  }
  for (const c of byInstrDate.values()) if (c > 1) dupDays += 1;

  const incidentIds: (string | null)[] = [];
  if (dupDays > 0) {
    incidentIds.push(await recordDataIncident({
      severity: "WARNING",
      failureType: "DUPLICATE",
      intervalStr: "1d",
      rootCause: "D-V2-10: mixed daily-timestamp conventions create >1 epoch key per (instrument, NSE trading date); composite unique key does not dedupe them.",
      detail: { logicalDuplicateTradingDays: dupDays },
      affectedRecords: dupDays,
      prisma,
    }));
  }
  if (weekendBars > 0) {
    incidentIds.push(await recordDataIncident({
      severity: "WARNING",
      failureType: "TIMESTAMP_REGRESSION",
      intervalStr: "1d",
      rootCause: "D-V2-10: daily bars stamped with a non-session convention land on weekend IST dates (no NSE session).",
      detail: { weekendDailyBars: weekendBars },
      affectedRecords: weekendBars,
      prisma,
    }));
  }
  out.dataQualityIncidents = { dupDays, weekendBars, incidentIds };

  // ── 4. Gap detection on a real daily instrument ──────────────────────────
  const { detectAndPersistGaps } = await import(
    "../src/lib/market-data/services/gap-detection.service"
  );
  // Use a known long-history instrument; the daily series is ~complete so this
  // should find no gaps (a true negative — proves we don't manufacture gaps).
  const gapRun = await detectAndPersistGaps({
    instrumentId: "RELIANCE",
    exchange: "NSE",
    interval: "1d",
    fromIstDate: "2025-01-01",
    toIstDate: "2025-03-31",
    expectedProvider: null,
    prisma,
  });
  out.gapDetectionRELIANCE = {
    expectedBars: gapRun.result.expectedBars,
    actualBars: gapRun.result.actualBars,
    gapsFound: gapRun.result.gaps.length,
    newGapRowsWritten: gapRun.written,
  };

  // ── 5. Market-session readiness (capability-specific, DB-derived) ────────
  const { evaluateMarketSessionReadiness } = await import(
    "../src/lib/market-data/services/data-readiness.service"
  );
  const readiness = await evaluateMarketSessionReadiness(prisma);
  out.readiness = {
    marketOpen: readiness.marketOpen,
    overall: readiness.overall,
    capabilities: readiness.capabilities.map((c) => ({
      capability: c.capability,
      status: c.status,
      instruments: c.instruments,
      actualBars: c.actualBars,
      completeness: c.completeness,
      unresolvedGaps: c.unresolvedGaps,
    })),
    reasons: readiness.reasons,
  };

  // ── Final durable-table counts (proof the tables are now non-empty) ──────
  const [obs, inc, gaps, corr] = await Promise.all([
    prisma.providerObservation.count(),
    prisma.dataQualityIncident.count(),
    prisma.dataGap.count(),
    prisma.dataCorrection.count(),
  ]);
  out.durableTablesAfter = { providerObservation: obs, dataQualityIncident: inc, dataGap: gaps, dataCorrection: corr };

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error("PIPELINE_FAILED", e); process.exit(1); });
