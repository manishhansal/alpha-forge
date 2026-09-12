/**
 * GET /api/in/historical-data/providers
 *
 * Returns the provider capability matrix and runtime statistics.
 * Answers: who provided data, was it authenticated, what rows.
 */

import "server-only";
import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  PROVIDER_CAPABILITY_MATRIX,
  renderCapabilityMatrixMarkdown,
} from "@/lib/market-data/provider-capability-matrix";
import { computeProviderReliability } from "@/lib/market-data/services/provider-reliability.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Source type for display
const SOURCE_TYPE_LABELS: Record<string, string> = {
  scrapling:  "BROKER_AUTHENTICATED",
  angel_one:  "BROKER_AUTHENTICATED",
  upstox:     "BROKER_AUTHENTICATED",
  jugaad:     "OPEN_SOURCE_NSE_DERIVED",
  openchart:  "OPEN_SOURCE_NSE_DERIVED",
  yahoo:      "YAHOO_FALLBACK",
};

export async function GET() {
  try {
    const prisma = getPrisma();
    const [reliability, provenance] = await Promise.all([
      computeProviderReliability(prisma),
      prisma.dataProvenance.groupBy({
        by: ["provider", "authenticated", "dataTrustStatus"],
        _count: { _all: true },
        _sum: { rowCount: true },
      }).catch(() => []),
    ]);

    // Candle rows by provider (from CandleBar.provider)
    const candlesByProvider = await prisma.candleBar.groupBy({
      by: ["provider"],
      where: { provider: { not: null } },
      _count: { _all: true },
    }).catch(() => []);

    // Build provider report
    const providers = PROVIDER_CAPABILITY_MATRIX.map((cap) => {
      const rel = reliability.find((r) => r.provider === cap.provider);
      const provRows = provenance.filter((p) => p.provider === cap.provider);
      const candleRows = candlesByProvider.find((c) => c.provider === cap.provider);

      const totalRows = provRows.reduce((s, p) => s + (p._sum.rowCount ?? 0), 0);
      const verifiedRows = provRows
        .filter((p) => p.dataTrustStatus?.startsWith("VERIFIED"))
        .reduce((s, p) => s + (p._sum.rowCount ?? 0), 0);

      return {
        provider: cap.provider,
        sourceType: SOURCE_TYPE_LABELS[cap.provider] ?? "UNKNOWN",
        authenticated: cap.requiresCredentials,
        note: cap.note,
        requestsPerSecond: cap.requestsPerSecond,
        supportedIntervals: Object.keys(cap.intervals).filter((i) => (cap.intervals as Record<string, { supported?: boolean }>)[i]?.supported),
        // Runtime stats
        sampleCount: rel?.sampleCount ?? 0,
        successRate: rel?.successRate ?? null,
        reliabilityStatus: rel?.reliabilityStatus ?? "NOT_VERIFIED",
        latencyMsP50: rel?.latencyMsP50 ?? null,
        latencyMsP95: rel?.latencyMsP95 ?? null,
        // Data volume
        candleRowsInDb: candleRows?._count._all ?? 0,
        provenanceRows: totalRows,
        verifiedRows,
        // Distinguish authenticated vs open-source
        authenticationLabel: cap.requiresCredentials
          ? "AUTHENTICATED (broker credentials required)"
          : "UNAUTHENTICATED (public/open-source)",
      };
    });

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      totalProviders: providers.length,
      authenticatedProviders: providers.filter((p) => p.authenticated).map((p) => p.provider),
      openSourceProviders: providers.filter((p) => !p.authenticated && p.provider !== "yahoo").map((p) => p.provider),
      fallbackProviders: providers.filter((p) => p.provider === "yahoo").map((p) => p.provider),
      capabilityMatrixMarkdown: renderCapabilityMatrixMarkdown(),
      providers,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Providers query failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
