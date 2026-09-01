import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/health/ready
 *
 * Aggregate readiness endpoint for AlphaForge. Reports the health of every
 * runtime dependency: database, redis, ml service, market data layer, and the
 * background worker heartbeat.
 *
 * Response shape:
 * {
 *   status: "ready" | "degraded" | "unavailable",
 *   timestamp: string,
 *   uptimeSeconds: number,
 *   dependencies: {
 *     [name]: {
 *       status:      "healthy" | "degraded" | "unhealthy" | "unknown",
 *       latencyMs:   number | null,
 *       lastSuccess: string | null,   // ISO-8601
 *       details:     Record<string, unknown>
 *     }
 *   }
 * }
 *
 * HTTP status codes:
 *   200 — all required deps healthy  (status: "ready")
 *   200 — some optional deps down    (status: "degraded")
 *   503 — database or redis unhealthy (status: "unavailable")
 */

const START_TIME = Date.now();

interface DepResult {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  latencyMs: number | null;
  lastSuccess: string | null;
  details: Record<string, unknown>;
}

// ─── Database probe ────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<DepResult> {
  const t0 = Date.now();
  try {
    // Dynamic import to keep server-only guard out of edge runtime
    const { getPrisma } = await import("@/lib/prisma");
    const db = getPrisma();
    await db.$queryRaw`SELECT 1 AS ping`;
    const latencyMs = Date.now() - t0;
    return {
      status: "healthy",
      latencyMs,
      lastSuccess: new Date().toISOString(),
      details: { engine: "postgresql", latencyMs },
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - t0,
      lastSuccess: null,
      details: { error: (err as Error).message },
    };
  }
}

// ─── Redis probe ───────────────────────────────────────────────────────────────

async function checkRedis(): Promise<DepResult> {
  const t0 = Date.now();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return {
      status: "unknown",
      latencyMs: null,
      lastSuccess: null,
      details: { note: "REDIS_URL not set — using in-memory fallback" },
    };
  }
  try {
    const { redis } = await import("@/lib/redis");
    await redis.ping();
    const probeKey = `health:ready:probe:${Date.now()}`;
    await redis.set(probeKey, "1", "EX", 10);
    const val = await redis.get(probeKey);
    await redis.del(probeKey);
    const latencyMs = Date.now() - t0;
    if (val !== "1") {
      return {
        status: "degraded",
        latencyMs,
        lastSuccess: null,
        details: { error: "round-trip value mismatch" },
      };
    }
    return {
      status: "healthy",
      latencyMs,
      lastSuccess: new Date().toISOString(),
      details: { roundTrip: "ok", latencyMs },
    };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - t0,
      lastSuccess: null,
      details: { error: (err as Error).message },
    };
  }
}

// ─── ML service probe ──────────────────────────────────────────────────────────

async function checkMlService(): Promise<DepResult> {
  const mlUrl = process.env.ML_SERVICE_URL;
  if (!mlUrl) {
    return {
      status: "unknown",
      latencyMs: null,
      lastSuccess: null,
      details: { note: "ML_SERVICE_URL not set — fallback mode active" },
    };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(`${mlUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      return {
        status: "unhealthy",
        latencyMs,
        lastSuccess: null,
        details: { httpStatus: res.status },
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      status: "healthy",
      latencyMs,
      lastSuccess: new Date().toISOString(),
      details: { ...body, latencyMs },
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    return {
      status: "unhealthy",
      latencyMs,
      lastSuccess: null,
      details: { error: (err as Error).message, url: mlUrl },
    };
  }
}

// ─── Market data probe ─────────────────────────────────────────────────────────

async function checkMarketData(): Promise<DepResult> {
  const t0 = Date.now();
  try {
    const { getProviderRegistry } = await import("@/lib/market-data/registry");
    const registry = getProviderRegistry();
    const providers = registry.getEnabledProviders();
    const healthyCount = providers.filter((p) => {
      const h = p.provider.getProviderHealth?.();
      return h ? !h.circuitOpen : true;
    }).length;
    const latencyMs = Date.now() - t0;
    const status =
      healthyCount === 0
        ? "unhealthy"
        : healthyCount < providers.length
          ? "degraded"
          : "healthy";
    return {
      status,
      latencyMs,
      lastSuccess: healthyCount > 0 ? new Date().toISOString() : null,
      details: {
        totalProviders: providers.length,
        healthyProviders: healthyCount,
        providers: providers.map((p) => ({
          id: p.provider.id,
          priority: p.priority,
          enabled: p.enabled,
        })),
      },
    };
  } catch (err) {
    return {
      status: "unknown",
      latencyMs: Date.now() - t0,
      lastSuccess: null,
      details: { note: "Registry not available", error: (err as Error).message },
    };
  }
}

// ─── Worker heartbeat probe ────────────────────────────────────────────────────

async function checkWorker(): Promise<DepResult> {
  const t0 = Date.now();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return {
      status: "unknown",
      latencyMs: null,
      lastSuccess: null,
      details: { note: "Redis unavailable — cannot check worker heartbeat" },
    };
  }
  try {
    const { redis } = await import("@/lib/redis");
    const heartbeatKey = "worker:heartbeat";
    const raw = await redis.get(heartbeatKey);
    const latencyMs = Date.now() - t0;
    if (!raw) {
      return {
        status: "unknown",
        latencyMs,
        lastSuccess: null,
        details: { note: "No heartbeat key found — worker may not be running" },
      };
    }
    const beat = JSON.parse(raw) as { ts: number; jobs: string[] };
    const ageMs = Date.now() - beat.ts;
    // Heartbeat is stale if > 5 minutes
    const status: DepResult["status"] = ageMs > 5 * 60_000 ? "degraded" : "healthy";
    return {
      status,
      latencyMs,
      lastSuccess: new Date(beat.ts).toISOString(),
      details: { ageMs, jobs: beat.jobs ?? [] },
    };
  } catch (err) {
    return {
      status: "unknown",
      latencyMs: Date.now() - t0,
      lastSuccess: null,
      details: { error: (err as Error).message },
    };
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const [database, redis, ml, marketData, worker] = await Promise.allSettled([
    checkDatabase(),
    checkRedis(),
    checkMlService(),
    checkMarketData(),
    checkWorker(),
  ]);

  const resolve = (r: PromiseSettledResult<DepResult>): DepResult =>
    r.status === "fulfilled"
      ? r.value
      : {
          status: "unhealthy",
          latencyMs: null,
          lastSuccess: null,
          details: { error: r.reason instanceof Error ? r.reason.message : String(r.reason) },
        };

  const deps = {
    database: resolve(database),
    redis: resolve(redis),
    ml: resolve(ml),
    marketData: resolve(marketData),
    worker: resolve(worker),
  };

  // Determine aggregate status
  // Required: database, redis
  // Optional (degraded, not unavailable): ml, marketData, worker
  const requiredHealthy =
    deps.database.status === "healthy" && deps.redis.status === "healthy";

  const optionalDegraded =
    deps.ml.status === "unhealthy" ||
    deps.marketData.status === "unhealthy" ||
    deps.worker.status === "unhealthy";

  const aggregateStatus: "ready" | "degraded" | "unavailable" = !requiredHealthy
    ? "unavailable"
    : optionalDegraded
      ? "degraded"
      : "ready";

  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);

  const body = {
    status: aggregateStatus,
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    dependencies: deps,
  };

  // 503 only when truly unavailable (DB or Redis down)
  const httpStatus = aggregateStatus === "unavailable" ? 503 : 200;

  return NextResponse.json(body, { status: httpStatus });
}
