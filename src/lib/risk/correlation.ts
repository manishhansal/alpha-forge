/**
 * correlation.ts — Rolling Correlation Risk
 *
 * Computes rolling pairwise correlations between instruments using a
 * configurable lookback window of daily returns. Clusters highly correlated
 * instruments and flags when a proposed trade would pile into a correlated cluster.
 *
 * Design notes:
 *  - Uses Pearson correlation on log-returns.
 *  - "High correlation" threshold is configurable (default ≥ 0.70).
 *  - Clustering uses single-linkage: two symbols are in the same cluster if
 *    corr(a, b) ≥ threshold OR corr(a, c) ≥ threshold AND corr(c, b) ≥ threshold.
 *  - Correlation data is fed in via `PriceHistory` — a lightweight map of
 *    symbol → close prices (oldest first).
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Map of symbol → array of close prices (oldest first). */
export type PriceHistory = Map<string, number[]>;

export interface CorrelationMatrix {
  /** Symbols included in the matrix (sorted). */
  symbols: string[];
  /**
   * Correlation[i][j] for symbols[i] and symbols[j].
   * Always 1.0 on the diagonal.
   */
  matrix: number[][];
  /** Rolling-window length used. */
  windowBars: number;
  /** UTC ms timestamp of last update. */
  updatedAtMs: number;
}

export interface CorrelationCluster {
  /** Index into CorrelationMatrix.symbols */
  symbolIndices: number[];
  symbols: string[];
  /** Mean pairwise correlation within this cluster. */
  avgCorrelation: number;
}

export interface CorrelationRiskCheck {
  breached: boolean;
  reason?: string;
  /** Highest correlation found between proposed symbol and an existing open position. */
  maxCorrelation: number;
  /** The open-position symbol that is most correlated with the proposed trade. */
  mostCorrelatedWith?: string;
  /** How many existing open longs are in the same correlation cluster. */
  clusterLongCount: number;
  limit: number;
}

export interface CorrelationConfig {
  /** Number of bars for the rolling correlation window. Default 60. */
  windowBars: number;
  /** Threshold above which two instruments are "highly correlated". Default 0.70. */
  highCorrThreshold: number;
  /**
   * Max number of simultaneous same-direction (long OR short) positions
   * in a high-correlation cluster. Default 3.
   */
  maxClusterPositions: number;
}

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  windowBars: 60,
  highCorrThreshold: 0.70,
  maxClusterPositions: 3,
};

// ── Math helpers ─────────────────────────────────────────────────────────────

/** Compute log-returns from a price series. Returns array of length n-1. */
function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev > 0 && prices[i] > 0) {
      returns.push(Math.log(prices[i] / prev));
    } else {
      returns.push(0);
    }
  }
  return returns;
}

/** Pearson correlation coefficient between two equal-length arrays. */
function pearsonCorr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

/** Take the last `n` elements of an array (or the whole array if shorter). */
function tail<T>(arr: T[], n: number): T[] {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

// ── Correlation matrix builder ────────────────────────────────────────────────

/**
 * Build a rolling correlation matrix for the provided symbols.
 * Only symbols present in `history` with at least 2 data points are included.
 */
export function buildCorrelationMatrix(
  symbols: string[],
  history: PriceHistory,
  config: CorrelationConfig = DEFAULT_CORRELATION_CONFIG,
  nowMs: number = Date.now(),
): CorrelationMatrix {
  // Filter to symbols with enough data
  const eligible = symbols.filter((s) => {
    const prices = history.get(s);
    return prices !== undefined && prices.length >= 2;
  });
  eligible.sort();

  // Pre-compute log-returns (windowed)
  const returnsMap = new Map<string, number[]>();
  for (const sym of eligible) {
    const prices = history.get(sym)!;
    const windowed = tail(prices, config.windowBars + 1);
    returnsMap.set(sym, logReturns(windowed));
  }

  const n = eligible.length;
  const matrix: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) => (i === j ? 1.0 : 0.0)),
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const rA = returnsMap.get(eligible[i])!;
      const rB = returnsMap.get(eligible[j])!;
      const corr = pearsonCorr(rA, rB);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return { symbols: eligible, matrix, windowBars: config.windowBars, updatedAtMs: nowMs };
}

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Single-linkage clustering: group symbols where any pair has correlation ≥ threshold.
 * Returns non-overlapping clusters (largest first).
 */
export function clusterByCorrelation(
  corrMatrix: CorrelationMatrix,
  threshold: number,
): CorrelationCluster[] {
  const { symbols, matrix } = corrMatrix;
  const n = symbols.length;
  const assigned = new Array(n).fill(false);
  const clusters: CorrelationCluster[] = [];

  for (let i = 0; i < n; i++) {
    if (assigned[i]) continue;

    // BFS to find all symbols reachable via high-correlation edges
    const clusterIndices: number[] = [i];
    assigned[i] = true;
    const queue = [i];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (let j = 0; j < n; j++) {
        if (!assigned[j] && Math.abs(matrix[cur][j]) >= threshold) {
          assigned[j] = true;
          clusterIndices.push(j);
          queue.push(j);
        }
      }
    }

    // Compute mean pairwise correlation within cluster
    let corrSum = 0;
    let pairs = 0;
    for (let a = 0; a < clusterIndices.length; a++) {
      for (let b = a + 1; b < clusterIndices.length; b++) {
        corrSum += matrix[clusterIndices[a]][clusterIndices[b]];
        pairs++;
      }
    }

    clusters.push({
      symbolIndices: clusterIndices,
      symbols: clusterIndices.map((idx) => symbols[idx]),
      avgCorrelation: pairs > 0 ? corrSum / pairs : 1.0,
    });
  }

  // Sort largest cluster first
  clusters.sort((a, b) => b.symbolIndices.length - a.symbolIndices.length);
  return clusters;
}

// ── Pre-trade correlation check ──────────────────────────────────────────────

/**
 * Check whether a proposed trade would exceed the correlated-cluster position limit.
 *
 * @param proposedSymbol  The symbol being considered for a new trade.
 * @param proposedDir     Direction of the new trade ("LONG" | "SHORT").
 * @param openPositions   Symbols + directions of current open positions.
 * @param corrMatrix      Latest correlation matrix (may not include proposed symbol).
 * @param config          Correlation limits config.
 */
export function checkCorrelationRisk(
  proposedSymbol: string,
  proposedDir: "LONG" | "SHORT",
  openPositions: Array<{ symbol: string; direction: "LONG" | "SHORT" }>,
  corrMatrix: CorrelationMatrix,
  config: CorrelationConfig = DEFAULT_CORRELATION_CONFIG,
): CorrelationRiskCheck {
  const { symbols, matrix } = corrMatrix;

  const proposedIdx = symbols.indexOf(proposedSymbol);

  // Correlation of proposed symbol with each open-position symbol
  let maxCorr = 0;
  let mostCorrelatedWith: string | undefined;

  const openSameDir = openPositions.filter((p) => p.direction === proposedDir);

  for (const op of openSameDir) {
    const opIdx = symbols.indexOf(op.symbol);
    if (proposedIdx === -1 || opIdx === -1) continue;

    const corr = Math.abs(matrix[proposedIdx][opIdx]);
    if (corr > maxCorr) {
      maxCorr = corr;
      mostCorrelatedWith = op.symbol;
    }
  }

  // Count cluster members among open positions (same direction)
  const clusters = clusterByCorrelation(corrMatrix, config.highCorrThreshold);
  let clusterLongCount = 0;

  for (const cluster of clusters) {
    if (
      proposedIdx !== -1 &&
      cluster.symbolIndices.includes(proposedIdx)
    ) {
      // Count how many open same-direction positions are in this cluster
      clusterLongCount = cluster.symbols.filter((s) =>
        openSameDir.some((op) => op.symbol === s),
      ).length;

      if (clusterLongCount >= config.maxClusterPositions) {
        return {
          breached: true,
          reason: `Cluster already has ${clusterLongCount} ${proposedDir} position(s) — max is ${config.maxClusterPositions} (avg cluster corr ${(cluster.avgCorrelation * 100).toFixed(0)}%)`,
          maxCorrelation: maxCorr,
          mostCorrelatedWith,
          clusterLongCount,
          limit: config.maxClusterPositions,
        };
      }
      break;
    }
  }

  return {
    breached: false,
    maxCorrelation: maxCorr,
    mostCorrelatedWith,
    clusterLongCount,
    limit: config.maxClusterPositions,
  };
}

// ── Correlation matrix updater ────────────────────────────────────────────────

/**
 * Append the latest close price for a symbol to its history, capping the
 * rolling window to avoid unbounded memory growth.
 */
export function updatePriceHistory(
  history: PriceHistory,
  symbol: string,
  closePrice: number,
  maxBars: number = 252,
): void {
  const existing = history.get(symbol) ?? [];
  existing.push(closePrice);
  if (existing.length > maxBars + 1) {
    existing.shift();
  }
  history.set(symbol, existing);
}

/**
 * Look up the correlation between two symbols in a matrix.
 * Returns 0 if either symbol is not found.
 */
export function getCorrelation(
  matrix: CorrelationMatrix,
  symbolA: string,
  symbolB: string,
): number {
  const i = matrix.symbols.indexOf(symbolA);
  const j = matrix.symbols.indexOf(symbolB);
  if (i === -1 || j === -1) return 0;
  return matrix.matrix[i][j];
}
