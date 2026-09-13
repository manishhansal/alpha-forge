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
 * Response shape:
 * {
 *   tradeId,
 *   paperTrade          — full PaperTrade record (with V2.1 provenance fields),
 *   signalRecord        — SignalIntelligenceRecord joined via trade.signalId,
 *   dataProvenanceRecord — DataProvenance joined via symbol + sessionDate + provider,
 *   lineageEntry        — market observation from data-service lineage store,
 *   qualityAtSignalTime — { score, grade } from the signal record's quality vector,
 *   retrievedAt
 * }
 *
 * Error cases:
 *   404 — trade not found, or (Req 16.6) no DataProvenanceRecord exists for the trade
 *   400 — missing / invalid tradeId
 *   500 — unexpected error
 *
 * Join strategy (derived from PaperTrade schema — no FK to SignalIntelligenceRecord):
 *   SignalIntelligenceRecord : PaperTrade.signalId → SignalIntelligenceRecord.signalId  (when present)
 *   DataProvenance           : PaperTrade.symbol   + sessionDate derived from openedAt
 *                              + PaperTrade.dataProviderAtEntry (falls back to ANY provider for that session)
 *
 * Requirements: 16.3, 16.6
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
      // V2.1 data provenance fields — used for joins
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
  // NSE session dates are IST calendar days (UTC+05:30).
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

  // ── 4. Fetch DataProvenance record ────────────────────────────────────────
  // Join strategy: symbol (instrumentId) + sessionDate + optional provider.
  // If the trade recorded dataProviderAtEntry, prefer a match on that provider.
  // Otherwise fall back to the most recent provenance record for the session.
  //
  // Requirement 16.6: if no record exists, return HTTP 404 with a structured
  // error identifying the missing provenance link and the tradeId.
  let dataProvenanceRecord: {
    id: string;
    datasetKey: string;
    instrumentId: string;
    exchange: string;
    intervalStr: string;
    sessionDate: string;
    provider: string;
    sourceType: string;
    authenticated: boolean;
    fetchedAt: Date;
    sourceTimestamp: Date | null;
    dataAsOf: Date | null;
    responseHash: string | null;
    responseTruncated: boolean;
    fromTs: Date | null;
    toTs: Date | null;
    datasetVersion: string;
    dataTrustStatus: string;
    rowCount: number;
    createdAt: Date;
  } | null = null;

  // Try with specific provider first (when trade recorded one)
  if (trade.dataProviderAtEntry) {
    dataProvenanceRecord = await prisma.dataProvenance.findFirst({
      where: {
        instrumentId: trade.symbol,
        sessionDate,
        provider: trade.dataProviderAtEntry,
      },
      orderBy: { fetchedAt: "desc" },
      select: {
        id: true,
        datasetKey: true,
        instrumentId: true,
        exchange: true,
        intervalStr: true,
        sessionDate: true,
        provider: true,
        sourceType: true,
        authenticated: true,
        fetchedAt: true,
        sourceTimestamp: true,
        dataAsOf: true,
        responseHash: true,
        responseTruncated: true,
        fromTs: true,
        toTs: true,
        datasetVersion: true,
        dataTrustStatus: true,
        rowCount: true,
        createdAt: true,
      },
    });
  }

  // Fallback: any provenance record for this symbol + session
  if (!dataProvenanceRecord) {
    dataProvenanceRecord = await prisma.dataProvenance.findFirst({
      where: {
        instrumentId: trade.symbol,
        sessionDate,
      },
      orderBy: { fetchedAt: "desc" },
      select: {
        id: true,
        datasetKey: true,
        instrumentId: true,
        exchange: true,
        intervalStr: true,
        sessionDate: true,
        provider: true,
        sourceType: true,
        authenticated: true,
        fetchedAt: true,
        sourceTimestamp: true,
        dataAsOf: true,
        responseHash: true,
        responseTruncated: true,
        fromTs: true,
        toTs: true,
        datasetVersion: true,
        dataTrustStatus: true,
        rowCount: true,
        createdAt: true,
      },
    });
  }

  // Requirement 16.6: return HTTP 404 when no DataProvenanceRecord exists.
  if (!dataProvenanceRecord) {
    return NextResponse.json(
      {
        error: "provenance_not_found",
        tradeId,
        symbol: trade.symbol,
        sessionDate,
        message:
          `No DataProvenanceRecord found for trade '${tradeId}' ` +
          `(symbol: ${trade.symbol}, session: ${sessionDate}). ` +
          `This trade was likely opened before the V8 provenance pipeline was wired, ` +
          `or the historical candle fetch for this session has not yet been recorded.`,
        missingProvenanceLink: {
          tradeId,
          symbol: trade.symbol,
          sessionDate,
          dataProviderAtEntry: trade.dataProviderAtEntry ?? null,
        },
      },
      { status: 404 },
    );
  }

  // ── 5. Fetch lineage entry from data-service (when observationId is present) ──
  let lineageEntry: Record<string, unknown> | null = null;
  let lineageLookupStatus = "SKIPPED";

  if (trade.dataObservationId) {
    try {
      const dataServiceUrl = process.env.DATA_SERVICE_URL ?? "http://localhost:8200";
      const res = await fetch(
        `${dataServiceUrl}/data/lineage/${trade.dataObservationId}`,
        { next: { revalidate: 0 } },
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

  // ── 6. Derive qualityAtSignalTime ─────────────────────────────────────────
  // Prefer the SignalIntelligenceRecord's score + grade (most authoritative).
  // Fall back to the trade's dataConfidenceAtEntry when no signal record exists.
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
    // Map confidence (0–95 scale) to a grade as a best-effort estimate.
    const conf = trade.dataConfidenceAtEntry;
    const grade =
      conf >= 90
        ? "A+"
        : conf >= 80
          ? "A"
          : conf >= 65
            ? "B"
            : conf >= 50
              ? "C"
              : conf >= 30
                ? "D"
                : "BLOCKED";
    qualityAtSignalTime = { score: conf, grade };
  }

  // ── 7. Build the structured response ─────────────────────────────────────
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
      // V2.1 provenance fields
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
    // null when trade.signalId is absent or no matching record was persisted
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

    // ── DataProvenanceRecord ──────────────────────────────────────────────
    dataProvenanceRecord: {
      id: dataProvenanceRecord.id,
      datasetKey: dataProvenanceRecord.datasetKey,
      instrumentId: dataProvenanceRecord.instrumentId,
      exchange: dataProvenanceRecord.exchange,
      intervalStr: dataProvenanceRecord.intervalStr,
      sessionDate: dataProvenanceRecord.sessionDate,
      provider: dataProvenanceRecord.provider,
      sourceType: dataProvenanceRecord.sourceType,
      authenticated: dataProvenanceRecord.authenticated,
      fetchedAt: dataProvenanceRecord.fetchedAt.toISOString(),
      sourceTimestamp: dataProvenanceRecord.sourceTimestamp?.toISOString() ?? null,
      dataAsOf: dataProvenanceRecord.dataAsOf?.toISOString() ?? null,
      responseHash: dataProvenanceRecord.responseHash ?? null,
      responseTruncated: dataProvenanceRecord.responseTruncated,
      fromTs: dataProvenanceRecord.fromTs?.toISOString() ?? null,
      toTs: dataProvenanceRecord.toTs?.toISOString() ?? null,
      datasetVersion: dataProvenanceRecord.datasetVersion,
      dataTrustStatus: dataProvenanceRecord.dataTrustStatus,
      rowCount: dataProvenanceRecord.rowCount,
      createdAt: dataProvenanceRecord.createdAt.toISOString(),
    },

    // ── Lineage Entry (from data-service in-memory store) ────────────────
    lineageEntry: {
      lookupStatus: lineageLookupStatus,
      record: lineageEntry,
    },

    // ── qualityAtSignalTime ───────────────────────────────────────────────
    // Populated from SignalIntelligenceRecord.score + .grade when available;
    // falls back to dataConfidenceAtEntry-derived estimate for pre-intelligence
    // trades.
    qualityAtSignalTime,

    // ── Forensics chain summary ───────────────────────────────────────────
    chain: buildForensicsChain(trade, signalRecord, dataProvenanceRecord, lineageEntry),

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

type ProvenanceFields = {
  provider: string;
  authenticated: boolean;
  dataTrustStatus: string;
  fetchedAt: Date;
  dataAsOf: Date | null;
};

type ChainStep = {
  step: number;
  layer: string;
  description: string;
  evidence: string;
};

/**
 * Build a human-readable step-by-step forensics chain describing the
 * market-data → signal → risk → paper-order path for this trade.
 */
function buildForensicsChain(
  trade: TradeFields,
  signalRecord: SignalRecordFields,
  provenance: ProvenanceFields,
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
        ? "LINEAGE_STORE"
        : trade.dataObservationId
          ? "TRADE_RECORD"
          : "NONE",
    },
    {
      step: 2,
      layer: "Data Provenance",
      description:
        `Provider: ${provenance.provider} ` +
        `(${provenance.authenticated ? "broker-authenticated" : "unauthenticated"}). ` +
        `Trust status: ${provenance.dataTrustStatus}. ` +
        `Fetched at: ${provenance.fetchedAt.toISOString()}. ` +
        `Data as-of: ${provenance.dataAsOf?.toISOString() ?? "N/A"}.`,
      evidence: "DATA_PROVENANCE_TABLE",
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
      evidence: signalRecord ? "SIGNAL_INTELLIGENCE_RECORD" : "TRADE_RECORD (meta JSONB)",
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
