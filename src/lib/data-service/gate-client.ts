/**
 * DataQualityGate client for the Next.js signal engine.
 *
 * This module provides the TypeScript-side integration point for the
 * data-service's DataQualityGate API (POST /data/gate).
 *
 * THE SIGNAL ENGINE MUST CHECK signalEngineAllowed BEFORE GENERATING ANY SIGNAL.
 * signalEngineAllowed=false is a HARD BLOCK — no signal may be generated.
 *
 * V2.1 Certification requirement: every signal path that produces a tradeable
 * signal must call evaluateDataGate() and check the result before proceeding.
 *
 * Evidence level: INTEGRATION_TESTED
 * Real network test: NOT_TESTED (requires live data-service + NSE session)
 */

const DATA_SERVICE_URL =
  process.env.DATA_SERVICE_URL ?? process.env.NEXT_PUBLIC_DATA_SERVICE_URL ?? "http://localhost:8200";

// ---------------------------------------------------------------------------
// Types — mirror of data-service GateRequest / gate response
// ---------------------------------------------------------------------------

export interface GateRequest {
  symbol: string;
  quoteAgeMs: number;
  completenessPercent?: number;
  timestampValid?: boolean;
  crossSourceAgreement?: number;
  sequenceIntegrity?: boolean;
  strategyId?: string;
  maxQuoteAgeMs?: number;
  minConfidenceScore?: number;
  requiresOI?: boolean;
  requiresOptionChain?: boolean;
  requiresConfirmedCandle?: boolean;
  oiAvailable?: boolean;
  optionChainAvailable?: boolean;
  candleConfirmed?: boolean;
}

export interface GateConditions {
  dataFresh: boolean;
  dataComplete: boolean;
  dataTimestampValid: boolean;
  dataProviderHealthy: boolean;
  dataSemanticallyValid: boolean;
}

export interface GateResponse {
  signalEngineAllowed: boolean;
  confidenceScore: number;
  quality: "VALID" | "DEGRADED" | "INVALID" | "STALE" | "UNKNOWN" | "PARTIAL";
  quoteAgeMs: number;
  gates: GateConditions;
  blockReasons: string[] | null;
  circuitBreakers: Record<string, string>;
  evaluatedAt: string;
  /** Present when data-service was unreachable — gate fails closed */
  error?: string;
}

// ---------------------------------------------------------------------------
// Fail-closed default — used when data-service is unreachable
// ---------------------------------------------------------------------------

const GATE_FAIL_CLOSED: GateResponse = {
  signalEngineAllowed: false,
  confidenceScore: 0,
  quality: "UNKNOWN",
  quoteAgeMs: 0,
  gates: {
    dataFresh: false,
    dataComplete: false,
    dataTimestampValid: false,
    dataProviderHealthy: false,
    dataSemanticallyValid: false,
  },
  blockReasons: ["data_service_unreachable"],
  circuitBreakers: {},
  evaluatedAt: new Date().toISOString(),
  error: "data_service_unreachable",
};

// ---------------------------------------------------------------------------
// Cache to avoid hammering the data-service on every signal evaluation.
// Gate evaluations for the same symbol are cached for 3 seconds.
// ---------------------------------------------------------------------------

interface CachedGate {
  response: GateResponse;
  expiresAt: number;
}

const _gateCache = new Map<string, CachedGate>();
const GATE_CACHE_TTL_MS = 3_000; // 3 seconds

function _cacheKey(req: GateRequest): string {
  return `${req.symbol}:${req.strategyId ?? ""}:${Math.floor(req.quoteAgeMs / 1000)}`;
}

// ---------------------------------------------------------------------------
// Core gate evaluation function
// ---------------------------------------------------------------------------

/**
 * Evaluate the DataQualityGate for a given instrument before signal generation.
 *
 * USAGE PATTERN:
 *   const gate = await evaluateDataGate({ symbol, quoteAgeMs, strategyId });
 *   if (!gate.signalEngineAllowed) {
 *     // HARD BLOCK — log and return, no signal
 *     return { blocked: true, reason: gate.blockReasons };
 *   }
 *   // proceed with signal generation...
 *
 * FAIL-CLOSED: if the data-service is unreachable, signalEngineAllowed=false.
 * This is intentional — we do not trade on unknown data quality.
 *
 * @param req Gate evaluation request
 * @returns GateResponse — always returns, never throws
 */
export async function evaluateDataGate(req: GateRequest): Promise<GateResponse> {
  // Check cache
  const key = _cacheKey(req);
  const cached = _gateCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  try {
    const response = await fetch(`${DATA_SERVICE_URL}/data/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(3_000), // 3s timeout — never block signal engine for too long
    });

    if (!response.ok) {
      // Non-2xx from data-service — fail closed
      return { ...GATE_FAIL_CLOSED, error: `data_service_http_${response.status}` };
    }

    const gate: GateResponse = await response.json();

    // Cache the result
    _gateCache.set(key, { response: gate, expiresAt: Date.now() + GATE_CACHE_TTL_MS });

    // Evict stale cache entries (simple LRU-style cleanup)
    if (_gateCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of _gateCache.entries()) {
        if (v.expiresAt < now) _gateCache.delete(k);
      }
    }

    return gate;
  } catch (err) {
    // Network error, timeout, or parse error — fail closed
    return {
      ...GATE_FAIL_CLOSED,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience: batch-evaluate gates for multiple symbols
// ---------------------------------------------------------------------------

/**
 * Evaluate gates for multiple symbols concurrently.
 * Returns a map from symbol → GateResponse.
 * Symbols with blocked gates are NOT filtered out — the caller decides.
 */
export async function evaluateDataGates(
  symbols: string[],
  baseReq: Omit<GateRequest, "symbol">,
): Promise<Map<string, GateResponse>> {
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      const gate = await evaluateDataGate({ symbol, ...baseReq });
      return [symbol, gate] as const;
    }),
  );
  return new Map(results);
}

/**
 * Filter symbols to only those with signalEngineAllowed=true.
 * Returns { allowed, blocked } maps.
 */
export async function filterByDataGate(
  symbols: string[],
  baseReq: Omit<GateRequest, "symbol">,
): Promise<{
  allowed: string[];
  blocked: Array<{ symbol: string; reason: string[] }>;
  gates: Map<string, GateResponse>;
}> {
  const gates = await evaluateDataGates(symbols, baseReq);
  const allowed: string[] = [];
  const blocked: Array<{ symbol: string; reason: string[] }> = [];

  for (const [symbol, gate] of gates) {
    if (gate.signalEngineAllowed) {
      allowed.push(symbol);
    } else {
      blocked.push({ symbol, reason: gate.blockReasons ?? ["unknown"] });
    }
  }

  return { allowed, blocked, gates };
}

// ---------------------------------------------------------------------------
// Strategy-specific gate helpers
// ---------------------------------------------------------------------------

/** Gate check for OI-dependent strategies. */
export async function evaluateOiStrategyGate(
  symbol: string,
  quoteAgeMs: number,
  oiAvailable: boolean,
): Promise<GateResponse> {
  return evaluateDataGate({
    symbol,
    quoteAgeMs,
    strategyId: "oi_scalper",
    maxQuoteAgeMs: 5_000,
    minConfidenceScore: 75,
    requiresOI: true,
    oiAvailable,
  });
}

/** Gate check for option chain strategies. */
export async function evaluateOptionChainGate(
  symbol: string,
  quoteAgeMs: number,
  optionChainAvailable: boolean,
): Promise<GateResponse> {
  return evaluateDataGate({
    symbol,
    quoteAgeMs,
    strategyId: "option_straddle",
    maxQuoteAgeMs: 30_000,
    minConfidenceScore: 70,
    requiresOptionChain: true,
    requiresOI: true,
    optionChainAvailable,
  });
}

/** Gate check for general India momentum/breakout strategies. */
export async function evaluateMomentumGate(
  symbol: string,
  quoteAgeMs: number,
): Promise<GateResponse> {
  return evaluateDataGate({
    symbol,
    quoteAgeMs,
    strategyId: "momentum",
    maxQuoteAgeMs: 15_000,
    minConfidenceScore: 60,
  });
}
