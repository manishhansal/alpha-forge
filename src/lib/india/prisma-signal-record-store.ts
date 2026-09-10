import "server-only";

import type { PrismaClient } from "@prisma/client";

import type {
  SignalRecordStore,
  PredictionRecord,
  ResolutionRecord,
  CompletedObservation,
  SignalDirection,
  LearnRegime,
  LearnTimeframe,
  LearnInstrument,
  LearnGrade,
  OutcomeState,
} from "./signal-learning-loop";

/**
 * Durable Prisma-backed implementation of `SignalRecordStore`.
 *
 * Replaces the in-memory-only store for production. Guarantees required by the
 * closed-loop learning contract:
 *
 *   • IMMUTABILITY  — a `PredictionRecord` is written exactly once. A second
 *     write for the same `signalId` throws (the DB primary key enforces this;
 *     we surface the same error the in-memory store does so callers behave
 *     identically). Historical scores are therefore never recomputed with a
 *     later algorithm — the creation-time snapshot is frozen.
 *
 *   • IDEMPOTENCY   — a `ResolutionRecord` is appended exactly once. A signal
 *     can never resolve twice: a duplicated resolution event is rejected, so
 *     no duplicate outcome row is created and win-rate/expectancy stats cannot
 *     be inflated by replays.
 *
 * All BigInt columns hold UTC-ms / epoch values; JSON columns hold the
 * immutable evidence snapshots. This module is I/O-bound (hence `server-only`);
 * the pure learning logic stays in `signal-learning-loop.ts`.
 */
export class PrismaSignalRecordStore implements SignalRecordStore {
  constructor(private readonly prisma: PrismaClient) {}

  async savePrediction(record: PredictionRecord): Promise<void> {
    // Immutability: reject a second write for the same signalId. We check-then-
    // create; the DB PK is the ultimate guard (a race surfaces as a unique
    // violation, which we normalise to the same error message).
    const existing = await this.prisma.indiaPredictionRecord.findUnique({
      where: { signalId: record.signalId },
      select: { signalId: true },
    });
    if (existing) {
      throw new Error(`prediction already exists (immutable): ${record.signalId}`);
    }
    try {
      await this.prisma.indiaPredictionRecord.create({
        data: {
          signalId: record.signalId,
          symbol: record.symbol,
          strategy: record.strategy,
          direction: record.direction,
          timestampMs: BigInt(Math.trunc(record.timestamp)),
          entry: record.entry,
          stop: record.stop,
          targets: record.targets,
          timeframe: record.timeframe,
          regime: record.regime,
          instrumentType: record.instrumentType,
          sector: record.sector,
          signalQuality: record.signalQuality,
          grade: record.grade,
          rawConfidence: record.rawConfidence,
          calibratedProbability: record.calibratedProbability,
          expectedValue: record.expectedValue,
          modelContributions: record.modelContributions,
          qualityComponents: record.qualityComponents,
          abstentionDecision: record.abstentionDecision,
          featureSnapshot: record.featureSnapshot,
          derivativesSnapshot: record.derivativesSnapshot,
          marketContext: record.marketContext,
          dataQuality: record.dataQuality,
          liquidity: record.liquidity,
          costEstimate: record.costEstimate,
          slippageEstimate: record.slippageEstimate,
          modelVersion: record.modelVersion,
          tradeDate: record.tradeDate,
        },
      });
    } catch (err) {
      // Normalise a unique-constraint race to the immutability error.
      if (isUniqueViolation(err)) {
        throw new Error(`prediction already exists (immutable): ${record.signalId}`);
      }
      throw err;
    }
  }

  async saveResolution(record: ResolutionRecord): Promise<void> {
    // A resolution requires an existing prediction (same rule as in-memory).
    const prediction = await this.prisma.indiaPredictionRecord.findUnique({
      where: { signalId: record.signalId },
      select: { signalId: true },
    });
    if (!prediction) {
      throw new Error(`cannot resolve unknown signal: ${record.signalId}`);
    }
    // Idempotency: reject a second resolution for the same signalId.
    const already = await this.prisma.indiaResolutionRecord.findUnique({
      where: { signalId: record.signalId },
      select: { signalId: true },
    });
    if (already) {
      throw new Error(`signal already resolved (idempotent): ${record.signalId}`);
    }
    try {
      await this.prisma.indiaResolutionRecord.create({
        data: {
          signalId: record.signalId,
          outcome: record.outcome,
          exit: record.exit,
          exitTimeMs: record.exitTime == null ? null : BigInt(Math.trunc(record.exitTime)),
          returnPct: record.returnPct,
          returnR: record.returnR,
          mfe: record.mfe,
          mae: record.mae,
          holdingTimeMs: record.holdingTimeMs == null ? null : BigInt(Math.trunc(record.holdingTimeMs)),
          targetReached: record.targetReached,
          stopReached: record.stopReached,
          costActual: record.costActual,
          slippageActual: record.slippageActual,
          netReturn: record.netReturn,
          regimeDuringTrade: record.regimeDuringTrade,
          ambiguous: record.ambiguous,
          resolvedAtMs: BigInt(Math.trunc(record.resolvedAt)),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new Error(`signal already resolved (idempotent): ${record.signalId}`);
      }
      throw err;
    }
  }

  async getPrediction(signalId: string): Promise<PredictionRecord | null> {
    const row = await this.prisma.indiaPredictionRecord.findUnique({ where: { signalId } });
    return row ? rowToPrediction(row) : null;
  }

  async listCompleted(): Promise<CompletedObservation[]> {
    const rows = await this.prisma.indiaResolutionRecord.findMany({
      include: { prediction: true },
      orderBy: [{ resolvedAtMs: "asc" }, { signalId: "asc" }],
    });
    const out: CompletedObservation[] = [];
    for (const r of rows) {
      if (!r.prediction) continue;
      out.push({ prediction: rowToPrediction(r.prediction), resolution: rowToResolution(r) });
    }
    return out;
  }

  async listOpenPredictions(): Promise<PredictionRecord[]> {
    const rows = await this.prisma.indiaPredictionRecord.findMany({
      where: { resolution: { is: null } },
      orderBy: { signalId: "asc" },
    });
    return rows.map(rowToPrediction);
  }
}

// ── row mappers ────────────────────────────────────────────────────────────

type PredRow = Awaited<ReturnType<PrismaClient["indiaPredictionRecord"]["findUnique"]>>;
type ResRow = Awaited<ReturnType<PrismaClient["indiaResolutionRecord"]["findUnique"]>>;

function rowToPrediction(row: NonNullable<PredRow>): PredictionRecord {
  return {
    signalId: row.signalId,
    symbol: row.symbol,
    strategy: row.strategy,
    direction: row.direction as SignalDirection,
    timestamp: Number(row.timestampMs),
    entry: row.entry,
    stop: row.stop,
    targets: row.targets,
    timeframe: row.timeframe as LearnTimeframe,
    regime: row.regime as LearnRegime,
    instrumentType: row.instrumentType as LearnInstrument,
    sector: row.sector,
    signalQuality: row.signalQuality,
    grade: row.grade as LearnGrade,
    rawConfidence: row.rawConfidence,
    calibratedProbability: row.calibratedProbability,
    expectedValue: row.expectedValue,
    modelContributions: row.modelContributions as Record<string, number>,
    qualityComponents: row.qualityComponents as Record<string, number>,
    abstentionDecision: row.abstentionDecision,
    featureSnapshot: row.featureSnapshot as Record<string, number>,
    derivativesSnapshot: row.derivativesSnapshot as Record<string, number | null>,
    marketContext: row.marketContext as Record<string, number | null>,
    dataQuality: row.dataQuality,
    liquidity: row.liquidity,
    costEstimate: row.costEstimate,
    slippageEstimate: row.slippageEstimate,
    modelVersion: row.modelVersion,
    tradeDate: row.tradeDate,
  };
}

function rowToResolution(row: NonNullable<ResRow>): ResolutionRecord {
  return {
    signalId: row.signalId,
    outcome: row.outcome as OutcomeState,
    exit: row.exit,
    exitTime: row.exitTimeMs == null ? null : Number(row.exitTimeMs),
    returnPct: row.returnPct,
    returnR: row.returnR,
    mfe: row.mfe,
    mae: row.mae,
    holdingTimeMs: row.holdingTimeMs == null ? null : Number(row.holdingTimeMs),
    targetReached: row.targetReached,
    stopReached: row.stopReached,
    costActual: row.costActual,
    slippageActual: row.slippageActual,
    netReturn: row.netReturn,
    regimeDuringTrade: row.regimeDuringTrade as LearnRegime,
    ambiguous: row.ambiguous,
    resolvedAt: Number(row.resolvedAtMs),
  };
}

/** Detect a Prisma P2002 unique-constraint violation without importing internals. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "P2002";
}
