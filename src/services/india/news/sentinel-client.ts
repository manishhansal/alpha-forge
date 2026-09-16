// Typed HTTP client for the SentinelPulse News Intelligence API.
//
// Base URL  : SENTINEL_PULSE_URL (env) — defaults to http://localhost:3001
// Auth      : Authorization: Bearer <SENTINEL_PULSE_API_KEY>
// Envelope  : { success: true, data: T, meta: {...} }
//           | { success: false, error: { code, message } }
//
// All methods throw a SentinelPulseError on non-2xx responses or network
// failures so callers can handle them uniformly. Never throws on 404 for
// optional lookups — those return null.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return (process.env.SENTINEL_PULSE_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}

function apiKey(): string {
  return process.env.SENTINEL_PULSE_API_KEY ?? "";
}

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SentinelPulseError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null = null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "SentinelPulseError";
  }
}

// ---------------------------------------------------------------------------
// Wire types — raw shapes returned by the SentinelPulse REST API
// ---------------------------------------------------------------------------

type Envelope<T> =
  | { success: true; data: T; meta: Record<string, unknown> }
  | {
      success: false;
      error: { code: string; message: string };
      meta?: Record<string, unknown>;
    };

// --- /api/v1/news/latest ----------------------------------------------------

export type SpArticle = {
  id: string;
  sourceId?: string;
  title: string;
  summary: string;
  canonicalUrl: string;
  publishedAt: string;
  category: string;
  language: string;
  source: { name: string; tier: number };
  clusterId?: string | null;
  author?: string | null;
  importance_score?: number;
  event_type?: string;
  primary_entities?: string[];
  sentiment?: {
    overall?: number | null;
    market?: number | null;
    company?: number | null;
    macro?: number | null;
    risk?: number | null;
  };
};

export type SpLatestResponse = {
  articles: SpArticle[];
};

export type SpLatestMeta = {
  total_count?: number;
  next_cursor?: string | null;
  has_more?: boolean;
};

export type LatestParams = {
  limit?: number;
  cursor?: string;
  asset_id?: string;
  sector?: string;
  event_type?: string;
  min_importance?: number;
  source_id?: string;
};

// --- /api/v1/news/market/india ----------------------------------------------

export type SpMarketBreadth = {
  advancing_articles_pct: number;
  declining_articles_pct: number;
  neutral_articles_pct: number;
  net_breadth: number;
  high_importance_count: number;
  window_minutes: number;
};

export type SpRegimeEntry = {
  regime: "RISK_ON" | "RISK_OFF" | "NEUTRAL" | "CRISIS";
  confidence: number;
  since: string;
  breadth_score?: number | null;
  volatility_percentile?: number | null;
};

export type SpHotEvent = {
  event_id: string;
  event_type: string;
  headline: string;
  importance_score: number;
  affected_assets: string[];
  published_at: string;
};

export type SpMarketIndiaResponse = {
  as_of: string;
  breadth: SpMarketBreadth | null;
  regime: {
    nifty50?: SpRegimeEntry;
    banknifty?: SpRegimeEntry;
    broad_market?: SpRegimeEntry;
    confidence?: number;
    since?: string;
  } | null;
  hot_events: SpHotEvent[];
};

// --- /api/v1/news/regime ----------------------------------------------------

export type SpRegimeResponse = {
  as_of: string;
  markets: {
    nifty50?: SpRegimeEntry;
    banknifty?: SpRegimeEntry;
    broad_market?: SpRegimeEntry;
  };
  next_update_at?: string | null;
};

// --- /api/v1/alphaforge/news-context/:instrument ----------------------------

export type SpAlphaForgeContext = {
  instrument: string;
  as_of: string;
  cache_hit: boolean;
  news_impact_score: number;
  impact_direction: "BULLISH" | "BEARISH" | "NEUTRAL" | string;
  impact_confidence: number;
  impact_horizon: string;
  sentiment: {
    overall: number | null;
    market: number | null;
    company: number | null;
    macro: number | null;
    risk: number | null;
  };
  event_count_24h: number;
  high_importance_event_count_24h: number;
  latest_event: {
    event_id: string;
    event_type: string;
    headline: string;
    published_at: string;
    importance_score: number;
    surprise_score: number;
  } | null;
  market_regime: string | null;
  explainability: {
    top_contributing_events: Array<{
      event_id: string;
      contribution_weight: number;
      event_type: string;
      direction: string;
    }>;
    score_breakdown: {
      direct_events: number;
      cross_market_effects: number;
      sentiment_contribution: number;
    };
  } | null;
};

// --- /api/v1/alphaforge/high-impact-events ----------------------------------

export type SpHighImpactEvent = {
  event_id: string;
  event_type: string;
  headline: string;
  published_at: string;
  source_id: string;
  importance_score: number;
  surprise_score: number;
  impact_direction: string;
  impact_confidence: number;
  affected_assets: string[];
  news_impact_score: number;
};

export type SpHighImpactEventsResponse = {
  events: SpHighImpactEvent[];
};

// ---------------------------------------------------------------------------
// Core fetch helper
// ---------------------------------------------------------------------------

async function spFetch<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const url = new URL(`${baseUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SentinelPulseError(`SentinelPulse network error: ${msg}`);
  }

  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new SentinelPulseError(
      `SentinelPulse returned non-JSON (HTTP ${res.status})`,
      res.status,
    );
  }

  if (!res.ok || !body.success) {
    const errBody = body as Extract<typeof body, { success: false }>;
    throw new SentinelPulseError(
      errBody.error?.message ?? `SentinelPulse HTTP ${res.status}`,
      res.status,
      errBody.error?.code ?? null,
    );
  }

  return {
    data: (body as Extract<typeof body, { success: true }>).data,
    meta: (body as Extract<typeof body, { success: true }>).meta,
  };
}

/**
 * Like spFetch but returns null on 404 instead of throwing. Useful for
 * optional per-instrument lookups that may not have data yet.
 */
async function spFetchOptional<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<{ data: T; meta: Record<string, unknown> } | null> {
  try {
    return await spFetch<T>(path, params);
  } catch (err: unknown) {
    if (err instanceof SentinelPulseError && err.statusCode === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API methods
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/news/latest
 * Returns the most recent normalised articles with optional filters.
 */
export async function fetchLatestArticles(
  params: LatestParams = {},
): Promise<{ articles: SpArticle[]; nextCursor: string | null; total: number | null }> {
  const p: Record<string, string | number | undefined> = {};
  if (params.limit !== undefined) p.limit = params.limit;
  if (params.cursor) p.cursor = params.cursor;
  if (params.asset_id) p.asset_id = params.asset_id;
  if (params.sector) p.sector = params.sector;
  if (params.event_type) p.event_type = params.event_type;
  if (params.min_importance !== undefined) p.min_importance = params.min_importance;
  if (params.source_id) p.source_id = params.source_id;

  const { data, meta } = await spFetch<SpLatestResponse | SpArticle[]>(
    "/api/v1/news/latest",
    p,
  );

  // Support both wrapped { articles: [...] } and bare array responses
  const articles: SpArticle[] = Array.isArray(data)
    ? data
    : (data as SpLatestResponse).articles ?? [];

  const m = meta as SpLatestMeta;
  return {
    articles,
    nextCursor: m.next_cursor ?? null,
    total: typeof m.total_count === "number" ? m.total_count : null,
  };
}

/**
 * GET /api/v1/news/market/india
 * Returns breadth, regime, and hot events for the Indian market.
 */
export async function fetchMarketIndia(): Promise<SpMarketIndiaResponse | null> {
  const result = await spFetchOptional<SpMarketIndiaResponse>(
    "/api/v1/news/market/india",
  );
  return result?.data ?? null;
}

/**
 * GET /api/v1/news/regime
 * Returns current regime classification for nifty50, banknifty, broad_market.
 */
export async function fetchRegime(): Promise<SpRegimeResponse | null> {
  const result = await spFetchOptional<SpRegimeResponse>("/api/v1/news/regime");
  return result?.data ?? null;
}

/**
 * GET /api/v1/alphaforge/news-context/:instrument
 * Primary AlphaForge integration endpoint — returns point-in-time news
 * context for a given NSE instrument. Returns null when the instrument is not
 * in the InstrumentMaster (404).
 */
export async function fetchAlphaForgeContext(
  instrument: string,
): Promise<SpAlphaForgeContext | null> {
  const result = await spFetchOptional<SpAlphaForgeContext>(
    `/api/v1/alphaforge/news-context/${encodeURIComponent(instrument)}`,
  );
  return result?.data ?? null;
}

/**
 * GET /api/v1/alphaforge/high-impact-events
 * Returns high-importance events ordered by importance_score descending.
 */
export async function fetchHighImpactEvents(params?: {
  limit?: number;
  cursor?: string;
  asset_id?: string;
  min_importance?: number;
  hours?: number;
}): Promise<{ events: SpHighImpactEvent[]; nextCursor: string | null }> {
  const p: Record<string, string | number | undefined> = {};
  if (params?.limit !== undefined) p.limit = params.limit;
  if (params?.cursor) p.cursor = params.cursor;
  if (params?.asset_id) p.asset_id = params.asset_id;
  if (params?.min_importance !== undefined) p.min_importance = params.min_importance;
  if (params?.hours !== undefined) p.hours = params.hours;

  const { data, meta } = await spFetch<SpHighImpactEventsResponse>(
    "/api/v1/alphaforge/high-impact-events",
    p,
  );

  return {
    events: data.events ?? [],
    nextCursor: (meta as { cursor?: string | null }).cursor ?? null,
  };
}
