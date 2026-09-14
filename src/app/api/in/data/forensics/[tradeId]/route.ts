import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/in/data/forensics/:tradeId
 *
 * Data-to-trade forensics endpoint — satisfies the full "what data produced
 * this trade?" audit chain required by certification requirement 16.3.
 *
 * NOTE (data-service2.0 centralization, Phase 2):
 * The `DataProvenance` table has been removed from the AlphaForge database.
 * Provenance records are now owned by data-service2.0. This endpoint still
 * returns the full PaperTrade record (with V2.1 provenance fields stamped at
 * trade time) and the SignalIntelligenceRecord, but the `dataProvenanceRecord`
 * field is now sourced from the lineage store in data-service2.0 rather than
 * a local DB query.
 *
 * Response shape:
 * {
 *   tradeId,
 *   paperTrade          — full PaperTrade record (with V2.1 provenance fields),
 *   signalRecord        — SignalIntelligenceRecord joined via trade.signalId,
 *   dataProvenanceNote  — explanation that provenance lives in data-service2.0,
 *   lineageEntry        — market observation from data-service2.0 lineage store,
 *   qualityAtSignalTime — { score, grade } from the signal record's quality vector,
 *   retrievedAt
 * }
 *
 * Error cases:
 *   404 — trade not found
 *   400 — missing / invalid tradeId
 *   500 — unexpected error
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ tradeId: string }> },
) {
  const { tradeId } = await params;

  if (!tradeId || typeof tradeId !== "string") {
    return NextResponse.json(
      { error: "tradeId is required and must be a string" },
      { status: 400 },
    );
  }

  const prisma = getPrisma();

  // ── 1. Fetch the PaperTrade record ───────────────────────────────────────
  const trade = await prisma.paperTrade.findUnique({
    where: { id: tradeId },
    select: {
      id: true,
      symbol: true,
      direction: true,
      status: true,
      source: true,
      rationale: true,
      meta: true,
      notional: true,
      entry: true,
      stopLoss: true,
      target: true,
      riskReward: true,
      atr: true,
      exitPrice: true,
      pnlPct: true,
      pnlUsd: true,
      currency: true,
      note: true,
      openedAt: true,
      closedAt: true,
      // V2.1 data provenance fields
      dataObservationId: true,
      quoteAgeAtEntryMs: true,
      dataConfidenceAtEntry: true,
      dataQualityAtEntry: true,
      dataProviderAtEntry: true,
      dataIsFallback: true,
      observationEventTime: true,
      signalId: true,
      featureVersion: true,
    },
  });

  if (!trade) {
    return NextResponse.json(
      {
        error: "trade_not_found",
        tradeId,
        message: `No paper trade found with id '${tradeId}'`,
      },
      { status: 404 },
    );
  }

  // ── 2. Derive the IST session date from the trade's openedAt ─────────────
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000;
  const istMs = trade.openedAt.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const sessionDate =
    `${istDate.getUTCFullYear()}-` +
    `${String(istDate.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(istDate.getUTCDate()).padStart(2, "0")}`;

  // ── 3. Fetch SignalIntelligenceRecord via signalId (when available) ───────
  let signalRecord: {
    id: string;
    signalId: string;
    strategyId: string;
    sourceType: string;
    instrument: string;
    exchange: string;
    sessionDate: string;
    timeframe: string;
    direction: string;
    entry: number;
    stopLoss: number;
    target: number;
    riskReward: number;
    atr: number;
    confidence: number;
    qualityVector: unknown;
    expectedValue: unknown;
    grade: string;
    score: number;
    regime: string;
    regimeFit: string;
    dataQuality: unknown;
    riskDecision: string;
    paperDecision: string;
    abstentionReason: string | null;
    lifecycleState: string;
    correlationId: string;
    featureVersion: string | null;
    rationale: string[];
    detectedAt: Date;
  } | null = null;

  if (trade.signalId) {
    signalRecord = await prisma.signalIntelligenceRecord.findUnique({
      where: { signalId: trade.signalId },
      select: {
        id: true,
        signalId: true,
        strategyId: true,
        sourceType: true,
        instrument: true,
        exchange: true,
        sessionDate: true,
        timeframe: true,
        direction: true,
        entry: true,
        stopLoss: true,
        target: true,
        riskReward: true,
        atr: true,
        confidence: true,
        qualityVector: true,
        expectedValue: true,
        grade: true,
        score: true,
        regime: true,
        regimeFit: true,
        dataQuality: true,
        riskDecision: true,
        paperDecision: true,
        abstentionReason: true,
        lifecycleState: true,
        correlationId: true,
        featureVersion: true,
        rationale: true,
        detectedAt: true,
      },
    });
  }

  // ── 4. Fetch lineage entry from data-service2.0 ───────────────────────────
  // DataProvenance was removed from AlphaForge DB (data-service2.0 centralization
  // Phase 2). Provenance is available via the data-service2.0 lineage store.
  let lineageEntry: Record<string, unknown> | null = null;
  let lineageLookupStatus = "SKIPPED";

  if (trade.dataObservationId) {
    try {
      const dataServiceUrl =
        process.env.DATA_SERVICE_2_URL ??
        process.env.DATA_SERVICE_URL ??
        "http://localhost:8200";

      const headers: HeadersInit = { Accept: "application/json" };
      const apiKey = process.env.DATA_SERVICE_API_KEY;
      if (apiKey) {
        (headers as Record<string, string>)["X-API-KEY"] = apiKey;
      }

      const res = await fetch(
        `${dataServiceUrl}/data/lineage/${trade.dataObservationId}`,
        { headers, signal: AbortSignal.timeout(5_000) },
      );
      if (res.ok) {
        lineageEntry = (await res.json()) as Record<string, unknown>;
        lineageLookupStatus = "FOUND";
      } else if (res.status === 404) {
        lineageLookupStatus = "NOT_FOUND_IN_LINEAGE_STORE";
      } else {
        lineageLookupStatus = `DATA_SERVICE_ERROR_${res.status}`;
      }
    } catch (err) {
      lineageLookupStatus = `FETCH_FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    lineageLookupStatus = "NO_OBSERVATION_ID_ON_TRADE";
  }

  // ── 5. Derive qualityAtSignalTime ─────────────────────────────────────────
  let qualityAtSignalTime: { score: number | null; grade: string | null } = {
    score: null,
    grade: null,
  };

  if (signalRecord) {
    qualityAtSignalTime = {
      score: signalRecord.score,
      grade: signalRecord.grade,
    };
  } else if (trade.dataConfidenceAtEntry !== null) {
    const conf = trade.dataConfidenceAtEntry;
    const grade =
      conf >= 90 ? "A+"
      : conf >= 80 ? "A"
      : conf >= 65 ? "B"
      : conf >= 50 ? "C"
      : conf >= 30 ? "D"
      : "BLOCKED";
    qualityAtSignalTime = { score: conf, grade };
  }

  // ── 6. Build the structured response ─────────────────────────────────────
  const meta = trade.meta as Record<string, unknown> | null;

  return NextResponse.json({
    tradeId: trade.id,

    // ── PaperTrade ────────────────────────────────────────────────────────
    paperTrade: {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      status: trade.status,
      source: trade.source,
      notional: trade.notional,
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      target: trade.target,
      riskReward: trade.riskReward,
      atr: trade.atr,
      exitPrice: trade.exitPrice ?? null,
      pnlPct: trade.pnlPct ?? null,
      pnlUsd: trade.pnlUsd ?? null,
      currency: trade.currency,
      note: trade.note ?? null,
      rationale: trade.rationale,
      meta,
      openedAt: trade.openedAt.toISOString(),
      closedAt: trade.closedAt?.toISOString() ?? null,
      // V2.1 provenance fields stamped at trade open time
      dataObservationId: trade.dataObservationId ?? null,
      quoteAgeAtEntryMs: trade.quoteAgeAtEntryMs ?? null,
      dataConfidenceAtEntry: trade.dataConfidenceAtEntry ?? null,
      dataQualityAtEntry: trade.dataQualityAtEntry ?? null,
      dataProviderAtEntry: trade.dataProviderAtEntry ?? null,
      dataIsFallback: trade.dataIsFallback ?? null,
      observationEventTime: trade.observationEventTime ?? null,
      signalId: trade.signalId ?? null,
      featureVersion: trade.featureVersion ?? null,
    },

    // ── SignalIntelligenceRecord ──────────────────────────────────────────
    signalRecord: signalRecord
      ? {
          id: signalRecord.id,
          signalId: signalRecord.signalId,
          strategyId: signalRecord.strategyId,
          sourceType: signalRecord.sourceType,
          instrument: signalRecord.instrument,
          exchange: signalRecord.exchange,
          sessionDate: signalRecord.sessionDate,
          timeframe: signalRecord.timeframe,
          direction: signalRecord.direction,
          entry: signalRecord.entry,
          stopLoss: signalRecord.stopLoss,
          target: signalRecord.target,
          riskReward: signalRecord.riskReward,
          atr: signalRecord.atr,
          confidence: signalRecord.confidence,
          qualityVector: signalRecord.qualityVector,
          expectedValue: signalRecord.expectedValue,
          grade: signalRecord.grade,
          score: signalRecord.score,
          regime: signalRecord.regime,
          regimeFit: signalRecord.regimeFit,
          dataQuality: signalRecord.dataQuality,
          riskDecision: signalRecord.riskDecision,
          paperDecision: signalRecord.paperDecision,
          abstentionReason: signalRecord.abstentionReason ?? null,
          lifecycleState: signalRecord.lifecycleState,
          correlationId: signalRecord.correlationId,
          featureVersion: signalRecord.featureVersion ?? null,
          rationale: signalRecord.rationale,
          detectedAt: signalRecord.detectedAt.toISOString(),
        }
      : null,

    // ── Data Provenance (migrated to data-service2.0) ────────────────────
    // The DataProvenance table was removed from AlphaForge as part of the
    // data-service2.0 centralization refactor (Phase 2, Sept 2026).
    // Provenance records for this trade's symbol and session are available
    // via data-service2.0. The V2.1 provenance fields on paperTrade
    // (dataObservationId, dataProviderAtEntry, dataQualityAtEntry, etc.)
    // remain the authoritative at-trade-time evidence on this record.
    dataProvenanceNote: {
      migrated: true,
      symbol: trade.symbol,
      sessionDate,
      dataProviderAtEntry: trade.dataProviderAtEntry ?? null,
      message:
        "DataProvenance records are now owned by data-service2.0. " +
        "Query the data-service2.0 provenance API for full dataset lineage. " +
        "The V2.1 fields on this paperTrade record (dataObservationId, " +
        "dataProviderAtEntry, dataQualityAtEntry, quoteAgeAtEntryMs, " +
        "dataIsFallback) capture the provenance snapshot at entry time.",
      dataService: {
        baseUrl:
          process.env.DATA_SERVICE_2_URL ??
          process.env.DATA_SERVICE_URL ??
          "http://localhost:8200",
        provenanceEndpoint: `/v1/provenance?symbol=${encodeURIComponent(trade.symbol)}&sessionDate=${sessionDate}`,
      },
    },

    // ── Lineage Entry (from data-service2.0) ─────────────────────────────
    lineageEntry: {
      lookupStatus: lineageLookupStatus,
      record: lineageEntry,
    },

    // ── qualityAtSignalTime ───────────────────────────────────────────────
    qualityAtSignalTime,

    // ── Forensics chain summary ───────────────────────────────────────────
    chain: buildForensicsChain(trade, signalRecord, lineageEntry),

    retrievedAt: new Date().toISOString(),
  });
}

// ── Forensics chain builder ───────────────────────────────────────────────────

type TradeFields = {
  symbol: string;
  direction: string;
  openedAt: Date;
  dataObservationId: string | null;
  dataProviderAtEntry: string | null;
  dataQualityAtEntry: string | null;
  observationEventTime: string | null;
  quoteAgeAtEntryMs: number | null;
  dataConfidenceAtEntry: number | null;
  dataIsFallback: boolean | null;
  meta: unknown;
  signalId: string | null;
};

type SignalRecordFields = {
  signalId: string;
  strategyId: string;
  grade: string;
  score: number;
  confidence: number;
  riskDecision: string;
  paperDecision: string;
  detectedAt: Date;
} | null;

type ChainStep = {
  step: number;
  layer: string;
  description: string;
  evidence: string;
};

function buildForensicsChain(
  trade: TradeFields,
  signalRecord: SignalRecordFields,
  lineageEntry: Record<string, unknown> | null,
): ChainStep[] {
  const meta = trade.meta as Record<string, unknown> | null;

  return [
    {
      step: 1,
      layer: "Market Observation",
      description: lineageEntry
        ? `Source: ${lineageEntry.source ?? "unknown"}. ` +
          `Event time: ${lineageEntry.eventTimeMs ?? "unknown"}ms. ` +
          `Received at: ${lineageEntry.receivedAtMs ?? "unknown"}ms.`
        : trade.dataObservationId
          ? `Observation ID: ${trade.dataObservationId}. ` +
            `Provider: ${trade.dataProviderAtEntry ?? "UNKNOWN"}. ` +
            `Event time: ${trade.observationEventTime ?? "unknown"}.`
          : "No observation ID recorded — trade predates V2.1 provenance wiring.",
      evidence: lineageEntry
        ? "DATA_SERVICE_LINEAGE_STORE"
        : trade.dataObservationId
          ? "TRADE_RECORD"
          : "NONE",
    },
    {
      step: 2,
      layer: "Data Provenance",
      description:
        "DataProvenance records are now owned by data-service2.0 (centralization Phase 2). " +
        `Provider at entry: ${trade.dataProviderAtEntry ?? "UNKNOWN"}. ` +
        `Observation event time: ${trade.observationEventTime ?? "N/A"}.`,
      evidence: "TRADE_RECORD (V2.1 provenance fields) + DATA_SERVICE_2_0",
    },
    {
      step: 3,
      layer: "Data Quality Gate",
      description:
        trade.dataConfidenceAtEntry !== null
          ? `Confidence: ${trade.dataConfidenceAtEntry}/95. ` +
            `Quality: ${trade.dataQualityAtEntry ?? "UNKNOWN"}. ` +
            `Quote age at entry: ${trade.quoteAgeAtEntryMs ?? "unknown"}ms. ` +
            `Fallback: ${trade.dataIsFallback ? "YES" : "NO"}.`
          : "Data quality gate not evaluated — trade predates V2.1 gate wiring.",
      evidence: trade.dataConfidenceAtEntry !== null ? "TRADE_RECORD" : "NONE",
    },
    {
      step: 4,
      layer: "Signal Generation",
      description: signalRecord
        ? `Signal ID: ${signalRecord.signalId}. ` +
          `Strategy: ${signalRecord.strategyId}. ` +
          `Confidence: ${signalRecord.confidence.toFixed(2)}. ` +
          `Grade: ${signalRecord.grade} (score: ${signalRecord.score}). ` +
          `Detected at: ${signalRecord.detectedAt.toISOString()}.`
        : `Strategy: ${meta?.strategyId ?? "unknown"}. ` +
          `Confidence: ${meta?.confidence ?? "unknown"}. ` +
          `Triggered at: ${
            meta?.triggeredAt
              ? new Date(meta.triggeredAt as number).toISOString()
              : trade.openedAt.toISOString()
          }.`,
      evidence: signalRecord
        ? "SIGNAL_INTELLIGENCE_RECORD"
        : "TRADE_RECORD (meta JSONB)",
    },
    {
      step: 5,
      layer: "Risk Decision",
      description: signalRecord
        ? `Risk decision: ${signalRecord.riskDecision}. Paper decision: ${signalRecord.paperDecision}.`
        : "Risk decision implicit in paper entry — no explicit SignalIntelligenceRecord for this trade.",
      evidence: signalRecord ? "SIGNAL_INTELLIGENCE_RECORD" : "TRADE_RECORD",
    },
    {
      step: 6,
      layer: "Paper Order",
      description:
        `Paper trade opened for ${trade.symbol} ${trade.direction} at ${trade.openedAt.toISOString()}. ` +
        (trade.signalId ? `Linked signal: ${trade.signalId}.` : "No linked signal ID."),
      evidence: "PAPER_TRADE_TABLE",
    },
  ];
}
