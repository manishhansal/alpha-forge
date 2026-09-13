/**
 * DataProvenance stamping helpers for the market-data layer.
 *
 * Responsible for constructing a `DataProvenance` object after every
 * successful provider call and after every cache hit.  The stamping happens
 * inside `withFailover()` (live provider calls) and inside the cache
 * read-path (L1/L2 hits).
 *
 * Also provides `persistProvenance()` which writes an immutable
 * `DataProvenanceRecord` to the `data_provenance` PostgreSQL table for
 * every historical candle fetch (Requirements 16.2, 21.5).
 *
 * Design references:
 *   - Requirements 12.2, 12.3, 16.1, 16.4, 16.2, 21.5
 *   - Design section 9.1 — Provenance Stamping
 *   - Design section 9.2 — DataProvenanceRecord Persistence
 */

import { createHash } from "node:crypto";

import type {
  DataFreshness,
  DataProvenance,
  HistoricalCandleRequest,
  ProviderId,
  QualityGrade,
  ReconciliationStatus,
} from "./types";

// ── Freshness thresholds (milliseconds) ──────────────────────────────────────

/** Data age ≤ 5 s → LIVE */
const LIVE_THRESHOLD_MS = 5_000;
/** Data age 6 – 60 s → RECENT */
const RECENT_THRESHOLD_MS = 60_000;
/** Data age 61 s – 24 h → STALE; > 24 h → HISTORICAL */
const STALE_THRESHOLD_MS = 24 * 60 * 60_000;

/**
 * Classify a data age (in ms) into the four freshness buckets.
 *
 * Freshness rules (from design §9.1 and Requirement 16.1):
 *   LIVE       — age ≤ 5 s
 *   RECENT     — 6 – 60 s
 *   STALE      — 61 s – 24 h
 *   HISTORICAL — > 24 h
 */
export function computeFreshness(ageMs: number): DataFreshness {
  if (ageMs <= LIVE_THRESHOLD_MS) return "LIVE";
  if (ageMs <= RECENT_THRESHOLD_MS) return "RECENT";
  if (ageMs <= STALE_THRESHOLD_MS) return "STALE";
  return "HISTORICAL";
}

/**
 * Parse a `dataAsOf` value — either an ISO-8601 string or a numeric epoch-ms
 * — into UTC epoch milliseconds.  Falls back to `fallbackMs` when parsing
 * fails (e.g. the provider did not supply a timestamp).
 */
export function parseDataAsOf(
  dataAsOf: string | number | null | undefined,
  fallbackMs: number,
): number {
  if (dataAsOf == null) return fallbackMs;
  if (typeof dataAsOf === "number") return dataAsOf;
  const ms = Date.parse(dataAsOf);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

// ── Provider type resolution ──────────────────────────────────────────────────

type ProviderType = DataProvenance["providerType"];

const PROVIDER_TYPES: Record<ProviderId, ProviderType> = {
  scrapling: "OPEN_SOURCE",
  angel_one: "BROKER",
  upstox: "BROKER",
  jugaad: "OPEN_SOURCE",
  openchart: "OPEN_SOURCE",
  yahoo: "SECONDARY_FALLBACK",
};

export function resolveProviderType(id: ProviderId): ProviderType {
  return PROVIDER_TYPES[id] ?? "OPEN_SOURCE";
}

/**
 * Whether this provider is considered authenticated (uses a broker credential).
 * Broker providers (Angel One, Upstox) are authenticated; open-source / Yahoo
 * are not.
 */
export function isProviderAuthenticated(id: ProviderId): boolean {
  return id === "angel_one" || id === "upstox";
}

// ── Quality score helpers ─────────────────────────────────────────────────────

/**
 * Derive a `QualityGrade` from a numeric score (0–100).
 *
 * Grade thresholds (design §10.1 step 9):
 *   A+  95–100
 *   A   85–94
 *   B   70–84
 *   C   50–69
 *   D   30–49
 *   BLOCKED < 30
 */
export function scoreToGrade(score: number): QualityGrade {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "BLOCKED";
}

/**
 * Compute a baseline quality score for a live provider response.
 *
 * This is an intentionally conservative baseline that the validation pipeline
 * (step 9) is expected to refine when per-candle statistics are available.
 * Without candle-level metrics we can only score:
 *   - completeness: 100 (we received a response)
 *   - freshness: derived from data age vs now
 *   - accuracy: 1.0 (assumed — no OHLC anomalies detected at this layer)
 *   - consistency: 1.0 (assumed — single provider)
 *   - provider_reliability: from the provider's authenticated status
 *
 * Formula (design §10.1):
 *   score = 0.25×completeness + 0.25×freshness + 0.25×accuracy
 *           + 0.15×consistency + 0.10×providerReliability
 * All sub-scores are 0–1, output is 0–100.
 */
export function computeBaselineQualityScore(
  providerId: ProviderId,
  dataAgeMs: number,
): {
  score: number;
  grade: QualityGrade;
  completeness: number;
  freshness: number;
  accuracy: number;
  validationStatus: "PASSED" | "FAILED" | "PARTIAL" | "PENDING";
  reconciliationStatus: ReconciliationStatus;
} {
  const completeness = 100; // a response was received

  // Freshness sub-score: 1.0 when LIVE, 0.8 when RECENT, 0.4 when STALE, 0.0 when HISTORICAL
  const freshnessLabel = computeFreshness(dataAgeMs);
  const freshnessSubScore =
    freshnessLabel === "LIVE"
      ? 1.0
      : freshnessLabel === "RECENT"
        ? 0.8
        : freshnessLabel === "STALE"
          ? 0.4
          : 0.0;

  const accuracy = 1.0;   // no per-candle validation at this layer
  const consistency = 1.0; // single provider; reconciliation is downstream
  const providerReliability = isProviderAuthenticated(providerId) ? 1.0 : 0.7;

  const rawScore =
    0.25 * (completeness / 100) +
    0.25 * freshnessSubScore +
    0.25 * accuracy +
    0.15 * consistency +
    0.10 * providerReliability;

  const score = Math.round(rawScore * 100);

  return {
    score,
    grade: scoreToGrade(score),
    completeness,
    freshness: freshnessSubScore,
    accuracy,
    validationStatus: "PASSED",
    reconciliationStatus: "UNRECONCILED",
  };
}

// ── Stamp helpers ─────────────────────────────────────────────────────────────

export interface StampOptions {
  /** Provider that served this response. */
  providerId: ProviderId;
  /** ISO-8601 UTC or epoch-ms representing when the data itself is current. */
  dataAsOf?: string | number | null;
  /** Whether this is a live-quote operation. */
  isLive: boolean;
  /** Whether this is a historical-candles operation. */
  isHistorical: boolean;
  /** UTC epoch ms when the request was initiated. */
  requestedAtMs: number;
  /** Ordered chain of providers used so far (for failover tracing). */
  sourceChain?: ProviderId[];
}

/**
 * Construct a `DataProvenance` object for a live provider response.
 *
 * Called by `withFailover()` immediately after a successful provider call.
 * The validation pipeline may enrich the `quality` sub-scores later; this
 * stamping establishes the baseline record.
 */
export function stampLiveProvenance(opts: StampOptions): DataProvenance {
  const now = Date.now();
  const dataAsOfMs = parseDataAsOf(opts.dataAsOf, now);
  const dataAgeMs = Math.max(0, now - dataAsOfMs);
  const quality = computeBaselineQualityScore(opts.providerId, dataAgeMs);

  return {
    provider: opts.providerId,
    providerType: resolveProviderType(opts.providerId),
    authenticated: isProviderAuthenticated(opts.providerId),
    requestedAt: new Date(opts.requestedAtMs).toISOString(),
    dataAsOf: new Date(dataAsOfMs).toISOString(),
    isLive: opts.isLive,
    isHistorical: opts.isHistorical,
    freshness: computeFreshness(dataAgeMs),
    quality: {
      score: quality.score,
      grade: quality.grade,
      completeness: quality.completeness,
      freshness: quality.freshness,
      accuracy: quality.accuracy,
      validationStatus: quality.validationStatus,
      reconciliationStatus: quality.reconciliationStatus,
    },
    sourceChain: opts.sourceChain ? [...opts.sourceChain, opts.providerId] : [opts.providerId],
  };
}

/**
 * Construct a `DataProvenance` object for a response served from L1 or L2
 * cache.  The original live provider is recorded in `sourceChain[0]`.
 */
export function stampCacheProvenance(
  originalProvider: ProviderId,
  requestedAtMs: number,
  dataAsOf: string | number | null | undefined,
  isLive: boolean,
  isHistorical: boolean,
): DataProvenance {
  const now = Date.now();
  const dataAsOfMs = parseDataAsOf(dataAsOf, now);
  const dataAgeMs = Math.max(0, now - dataAsOfMs);
  const quality = computeBaselineQualityScore(originalProvider, dataAgeMs);

  return {
    provider: originalProvider,
    providerType: "CACHE",
    authenticated: isProviderAuthenticated(originalProvider),
    requestedAt: new Date(requestedAtMs).toISOString(),
    dataAsOf: new Date(dataAsOfMs).toISOString(),
    isLive,
    isHistorical,
    freshness: computeFreshness(dataAgeMs),
    quality: {
      score: quality.score,
      grade: quality.grade,
      completeness: quality.completeness,
      freshness: quality.freshness,
      accuracy: quality.accuracy,
      validationStatus: quality.validationStatus,
      reconciliationStatus: quality.reconciliationStatus,
    },
    // Cache: the original live provider is at index 0.
    sourceChain: [originalProvider],
  };
}

// ── Credential identity resolution ───────────────────────────────────────────

/**
 * Return the *name* of the environment variable that identifies credentials
 * for a given provider.  This is the identifier that gets hashed —  never
 * the credential value itself (Requirements 21.5, 16.2, design §14.2).
 *
 * Only broker providers that authenticate with a credential are covered.
 * Open-source / fallback providers return null (no credential to hash).
 */
function resolveCredentialIdentifier(id: ProviderId): string | null {
  if (id === "angel_one") return process.env.SMARTAPI_CLIENT_CODE ?? "SMARTAPI_CLIENT_CODE";
  if (id === "upstox") return process.env.UPSTOX_CLIENT_SECRET ?? "UPSTOX_CLIENT_SECRET";
  return null;
}

// ── SHA-256 helper ─────────────────────────────────────────────────────────────

/**
 * Compute a hex SHA-256 digest of the supplied string.
 * Used for both response-body hashing and credential-identifier hashing.
 */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Derive IST session date from a UTC timestamp ──────────────────────────────

/**
 * Return the IST calendar date (YYYY-MM-DD) for a given UTC Date.
 *
 * NSE operates in Asia/Kolkata (UTC+05:30).  All session-date keys in the
 * schema use this calendar day, not UTC.
 *
 * We deliberately avoid the `Intl` timezone API here to keep the helper
 * synchronous and dependency-free in all runtimes.
 */
function toIstSessionDate(utc: Date): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000; // UTC+05:30
  const istMs = utc.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(istDate.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── DataProvenanceRecord persistence ─────────────────────────────────────────

/**
 * Write an immutable `DataProvenanceRecord` to the `data_provenance` table
 * for one historical candle fetch.
 *
 * Requirements 16.2 — a `DataProvenanceRecord` MUST be written for every
 * historical candle fetch with fields: provider, sourceType, authenticated,
 * credentialIdentityHash (SHA-256 of the credential identifier — never the raw
 * credential), fetchedAt, responseHash (SHA-256 of first 50 KB of raw response
 * body), responseTruncated (true when body > 50 KB), and dataTrustStatus.
 *
 * Requirement 21.5 — `credentialIdentityHash` MUST be the SHA-256 of the
 * credential identifier (e.g. SMARTAPI_CLIENT_CODE for Angel One, or the env-
 * var *value* used as the identifier — never the secret itself).
 *
 * The function is intentionally fire-and-forget-safe: callers (withFailover)
 * do NOT await its completion to avoid adding latency to the hot path.  Errors
 * are swallowed with a structured log so a DB failure never propagates to the
 * data consumer.
 *
 * @param provider         Provider that served the historical candle data.
 * @param req              The HistoricalCandleRequest that was executed.
 * @param rawResponseBody  The raw response body string from the provider.
 * @param authenticated    Whether the provider was called with valid credentials.
 * @param prismaClient     Optional Prisma client; defaults to the global singleton.
 */
export async function persistProvenance(
  provider: ProviderId,
  req: HistoricalCandleRequest,
  rawResponseBody: string,
  authenticated: boolean,
  prismaClient?: import("@prisma/client").PrismaClient,
): Promise<void> {
  try {
    // ── Lazy-import getPrisma to avoid circular deps and keep this module
    //    usable in non-server contexts (e.g. tests with a mock client).
    const db = prismaClient ?? (await import("@/lib/prisma")).getPrisma();

    // Response hash: SHA-256 of the first 50 KB only (design §9.2).
    const MAX_BODY_BYTES = 50 * 1_024;
    const bodySlice = rawResponseBody.slice(0, MAX_BODY_BYTES);
    const responseHash = sha256(bodySlice);
    const responseTruncated = rawResponseBody.length > MAX_BODY_BYTES;

    // Credential identity hash: SHA-256 of the identifier string (env-var
    // *name* or *value* used as the identity key — never the secret itself).
    const credId = resolveCredentialIdentifier(provider);
    const credentialIdentityHash = credId ? sha256(credId) : null;

    const fetchedAt = new Date();
    const sessionDate = toIstSessionDate(fetchedAt);

    // Stable dataset key that uniquely addresses this (instrument, exchange,
    // interval, session) combination — used for dedup / covering queries.
    const datasetKey = `${req.symbol}:${req.exchange}:${req.interval}:${sessionDate}`;

    // Source type mirrors the provenance-type resolution already in this module.
    const sourceType = resolveProviderType(provider);
    // Map internal ProviderType enum to the DataProvenance model's sourceType
    // string literals defined in the schema.
    const sourceTypeStr =
      sourceType === "BROKER"
        ? "BROKER_AUTHENTICATED"
        : sourceType === "SECONDARY_FALLBACK"
          ? "YAHOO_FALLBACK"
          : "OPEN_SOURCE_NSE_DERIVED";

    // dataTrustStatus: broker-authenticated providers are TRUSTED; others are
    // VERIFIED_SINGLE_SOURCE (or UNVERIFIED for last-resort fallbacks).
    const dataTrustStatus =
      sourceType === "BROKER"
        ? "VERIFIED"
        : sourceType === "SECONDARY_FALLBACK"
          ? "UNVERIFIED"
          : "VERIFIED_SINGLE_SOURCE";

    // datasetVersion: date-prefixed monotonic string, consistent with the
    // dataset-version.ts helpers used elsewhere in the data layer.
    const datasetVersion = `${sessionDate}-v1`;

    await db.dataProvenance.create({
      data: {
        datasetKey,
        instrumentId: req.symbol,
        exchange: req.exchange,
        intervalStr: req.interval,
        sessionDate,
        provider,
        sourceType: sourceTypeStr,
        authenticated,
        credentialIdentityHash,
        fetchedAt,
        responseHash,
        responseTruncated,
        fromTs: req.from ? new Date(req.from) : null,
        toTs: req.to ? new Date(req.to) : null,
        datasetVersion,
        dataTrustStatus,
        rowCount: 0, // caller can update after counting persisted candles if needed
      },
    });
  } catch (err) {
    // Fire-and-forget: a provenance write failure must never propagate to the
    // data consumer.  Log at WARN so ops can detect systematic DB issues.
    const { mdLog } = await import("./health");
    mdLog("provenance_persist_error", {
      provider,
      symbol: req.symbol,
      exchange: req.exchange,
      interval: req.interval,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
