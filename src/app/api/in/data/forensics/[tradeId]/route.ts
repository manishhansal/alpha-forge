import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

/**
 * GET /api/in/data/forensics/:tradeId
 *
 * Data-to-trade forensics endpoint — answers the question:
 *   "What data produced this trade?"
 *
 * Returns the full forensics chain:
 *   trade → paper fill metadata → signal decision → data provenance
 *   → market observation → provider
 *
 * This endpoint satisfies the V2.1 certification requirement for
 * end-to-end forensics (Phase 14 / Section 59 of the cert mandate).
 *
 * Evidence Level:
 *   - Trade record: CERTIFIED (persisted in PaperTrade table)
 *   - Data provenance fields: CERTIFIED (V2.1 migration applied)
 *   - Lineage store lookup: INTEGRATION_TESTED (in-memory, 50k entries)
 *   - Signal reconstruction: PARTIALLY_CERTIFIED (meta JSONB available)
 *   - Live observation replay: NOT_CERTIFIED (requires persistent lineage)
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ tradeId: string }> },
) {
  const { tradeId } = await params;

  if (!tradeId || typeof tradeId !== "string") {
    return NextResponse.json({ error: "tradeId is required" }, { status: 400 });
  }

  const prisma = getPrisma();

  // ── 1. Retrieve the trade ────────────────────────────────────────────────
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
      entry: true,
      stopLoss: true,
      target: true,
      riskReward: true,
      atr: true,
      exitPrice: true,
      pnlPct: true,
      pnlUsd: true,
      currency: true,
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
        message: "No paper trade found with this ID",
      },
      { status: 404 },
    );
  }

  // ── 2. Resolve data provenance from data-service lineage store ───────────
  // If this trade has a dataObservationId, look it up in the data-service
  // lineage store to get the full market observation record.
  let lineageRecord: Record<string, unknown> | null = null;
  let lineageLookupStatus = "SKIPPED";

  if (trade.dataObservationId) {
    try {
      const dataServiceUrl =
        process.env.DATA_SERVICE_URL ?? "http://localhost:8200";
      const res = await fetch(
        `${dataServiceUrl}/data/lineage/${trade.dataObservationId}`,
        { next: { revalidate: 0 } },
      );
      if (res.ok) {
        lineageRecord = await res.json();
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

  // ── 3. Build the forensics chain ─────────────────────────────────────────
  const meta = trade.meta as Record<string, unknown>;

  const forensics = {
    // Top-level identity
    tradeId: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    status: trade.status,
    source: trade.source,
    openedAt: trade.openedAt.toISOString(),
    closedAt: trade.closedAt?.toISOString() ?? null,

    // ── Fill / Execution ─────────────────────────────────────────────────
    fill: {
      entry: trade.entry,
      stopLoss: trade.stopLoss,
      target: trade.target,
      riskReward: trade.riskReward,
      atr: trade.atr,
      exitPrice: trade.exitPrice ?? null,
      pnlPct: trade.pnlPct ?? null,
      pnlUsd: trade.pnlUsd ?? null,
      currency: trade.currency,
    },

    // ── Signal Decision ──────────────────────────────────────────────────
    signalDecision: {
      signalId: trade.signalId ?? null,
      strategyId: meta?.strategyId ?? null,
      confidence: meta?.confidence ?? null,
      confirmed: meta?.confirmed ?? null,
      featureVersion: trade.featureVersion ?? meta?.featureVersion ?? null,
      rationale: trade.rationale,
      triggeredAt: meta?.triggeredAt
        ? new Date(meta.triggeredAt as number).toISOString()
        : trade.openedAt.toISOString(),
      triggeredAtPrice: meta?.triggeredAtPrice ?? null,
    },

    // ── Data Provenance at Entry ─────────────────────────────────────────
    dataProvenance: {
      observationId: trade.dataObservationId ?? null,
      quoteAgeAtEntryMs: trade.quoteAgeAtEntryMs ?? null,
      dataConfidence: trade.dataConfidenceAtEntry ?? null,
      dataQuality: trade.dataQualityAtEntry ?? "UNKNOWN",
      provider: trade.dataProviderAtEntry ?? "UNKNOWN",
      isFallback: trade.dataIsFallback ?? false,
      observationEventTime: trade.observationEventTime ?? null,
      // Provenance quality assessment
      provenanceComplete: !!(
        trade.dataObservationId &&
        trade.quoteAgeAtEntryMs !== null &&
        trade.dataConfidenceAtEntry !== null &&
        trade.dataQualityAtEntry
      ),
      provenanceVersion: "2.1.0",
    },

    // ── Lineage Store Lookup ─────────────────────────────────────────────
    lineage: {
      lookupStatus: lineageLookupStatus,
      record: lineageRecord,
      note: lineageRecord
        ? "Full market observation record retrieved from data-service lineage store"
        : "Lineage record not available. The in-memory lineage store holds the most recent 50,000 observations. Trades from previous sessions require persistent lineage storage.",
    },

    // ── Forensics Chain Summary ──────────────────────────────────────────
    chain: buildForensicsChain(trade, lineageRecord),

    // ── Certification Status ─────────────────────────────────────────────
    certificationStatus: {
      tradeRecord: "CERTIFIED",
      dataProvenance: trade.dataObservationId
        ? "CERTIFIED"
        : "MISSING — trade was created before V2.1 provenance wiring",
      lineageResolution: lineageLookupStatus === "FOUND"
        ? "INTEGRATION_TESTED"
        : "NOT_CERTIFIED — lineage not available for this trade",
      signalReconstruction: trade.signalId ? "PARTIALLY_CERTIFIED" : "NOT_CERTIFIED",
      liveObservationReplay: "NOT_CERTIFIED — requires persistent lineage storage",
    },

    retrievedAt: new Date().toISOString(),
  };

  return NextResponse.json(forensics);
}

/**
 * Build a human-readable forensics chain description showing the
 * complete data → trade path.
 */
function buildForensicsChain(
  trade: {
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
  },
  lineageRecord: Record<string, unknown> | null,
): Array<{ step: number; layer: string; description: string; evidence: string }> {
  const meta = trade.meta as Record<string, unknown>;

  return [
    {
      step: 1,
      layer: "Market Observation",
      description: lineageRecord
        ? `Source: ${lineageRecord.source}. Event time: ${lineageRecord.eventTimeMs}ms. Received at: ${lineageRecord.receivedAtMs}ms.`
        : trade.dataObservationId
          ? `Observation ID: ${trade.dataObservationId}. Provider: ${trade.dataProviderAtEntry ?? "UNKNOWN"}. Event time: ${trade.observationEventTime ?? "unknown"}.`
          : "No observation ID recorded — trade predates V2.1 provenance wiring.",
      evidence: lineageRecord ? "LINEAGE_STORE" : trade.dataObservationId ? "TRADE_RECORD" : "NONE",
    },
    {
      step: 2,
      layer: "Data Quality Gate",
      description: trade.dataConfidenceAtEntry !== null
        ? `Confidence: ${trade.dataConfidenceAtEntry}/95. Quality: ${trade.dataQualityAtEntry ?? "UNKNOWN"}. ` +
          `Quote age at entry: ${trade.quoteAgeAtEntryMs ?? "unknown"}ms. Fallback: ${trade.dataIsFallback ? "YES" : "NO"}.`
        : "Data quality gate not evaluated — trade predates V2.1 gate wiring.",
      evidence: trade.dataConfidenceAtEntry !== null ? "TRADE_RECORD" : "NONE",
    },
    {
      step: 3,
      layer: "Signal Generation",
      description: `Strategy: ${meta?.strategyId ?? "unknown"}. Confidence: ${meta?.confidence ?? "unknown"}. ` +
        `Confirmed: ${meta?.confirmed ?? "unknown"}. Triggered at: ${
          meta?.triggeredAt ? new Date(meta.triggeredAt as number).toISOString() : trade.openedAt.toISOString()
        }.`,
      evidence: "TRADE_RECORD (meta JSONB)",
    },
    {
      step: 4,
      layer: "Risk Decision",
      description: `Entry: ${((trade.meta as Record<string, unknown>)?.triggeredAtPrice) ?? "N/A"}. ` +
        "Risk decision implicit in paper entry (no explicit risk engine record for this trade).",
      evidence: "TRADE_RECORD",
    },
    {
      step: 5,
      layer: "Paper Order",
      description: `Paper trade opened for ${trade.symbol} ${trade.direction} at ${trade.openedAt.toISOString()}.`,
      evidence: "TRADE_RECORD",
    },
    {
      step: 6,
      layer: "Fill",
      description: `Entry recorded in PaperTrade table. No execution fill (paper trading is instantaneous).`,
      evidence: "TRADE_RECORD",
    },
  ];
}
