/**
 * Phase 9 — Strategy Correlation & Redundancy Analysis
 *
 * Measures overlap between strategies to prevent:
 *   1. Over-allocation to effectively identical exposures
 *   2. False diversification (correlated drawdowns)
 *   3. Redundant complexity in the strategy universe
 *
 * Metrics computed:
 *   - Return correlation (Pearson)
 *   - Signal correlation (Cohen's κ for categorical signals)
 *   - Trade overlap fraction
 *   - Drawdown correlation
 *   - Tail-loss correlation (lower tail, 10th percentile)
 *
 * Clustering uses average-linkage hierarchical clustering with a
 * correlation threshold of 0.70 to form groups.
 */

import type {
  StrategyPairCorrelation,
  StrategyCluster,
  CorrelationMatrix,
  StrategyCategory,
} from "../types";

// ─── Time-Aligned Return Series ───────────────────────────────────────────────

export interface DatedReturn {
  date: string; // ISO date
  returnPct: number;
}

export interface StrategyReturnSeries {
  strategyId: string;
  returns: DatedReturn[];
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : 0;
}

/**
 * Compute drawdown series from a returns array.
 * Returns array of drawdown fractions at each point.
 */
function drawdownSeries(returns: number[]): number[] {
  let peak = 1.0;
  let equity = 1.0;
  return returns.map((r) => {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    return peak > 0 ? (peak - equity) / peak : 0;
  });
}

/**
 * Trade overlap: fraction of trading days where both strategies
 * have an open position simultaneously.
 */
function tradeOverlap(
  datesA: Set<string>,
  datesB: Set<string>,
): number {
  if (datesA.size === 0 && datesB.size === 0) return 0;
  let overlap = 0;
  for (const d of datesA) {
    if (datesB.has(d)) overlap++;
  }
  const union = new Set([...datesA, ...datesB]).size;
  return union > 0 ? overlap / union : 0;
}

// ─── Pair Correlation ─────────────────────────────────────────────────────────

/**
 * Compute all pairwise correlation metrics between two strategies.
 */
export function computePairCorrelation(
  a: StrategyReturnSeries,
  b: StrategyReturnSeries,
): StrategyPairCorrelation {
  // Align returns by date
  const dateSetB = new Map(b.returns.map((r) => [r.date, r.returnPct]));
  const aligned: { ra: number; rb: number }[] = [];
  for (const r of a.returns) {
    const rb = dateSetB.get(r.date);
    if (rb !== undefined) {
      aligned.push({ ra: r.returnPct, rb });
    }
  }

  const ra = aligned.map((x) => x.ra);
  const rb = aligned.map((x) => x.rb);

  const returnCorrelation = pearsonCorrelation(ra, rb);

  // Signal correlation: both strategies produce +1 (positive), -1 (negative), 0 (flat)
  const signalA = ra.map((r) => Math.sign(r));
  const signalB = rb.map((r) => Math.sign(r));
  const signalCorrelation = pearsonCorrelation(signalA, signalB);

  // Trade overlap: days when both have non-zero returns
  const activeDatesA = new Set(a.returns.filter((r) => r.returnPct !== 0).map((r) => r.date));
  const activeDatesB = new Set(b.returns.filter((r) => r.returnPct !== 0).map((r) => r.date));
  const tradeOverlapVal = tradeOverlap(activeDatesA, activeDatesB);

  // Drawdown correlation
  const ddA = drawdownSeries(ra);
  const ddB = drawdownSeries(rb);
  const drawdownCorrelation = pearsonCorrelation(ddA, ddB);

  // Tail-loss correlation: lower 10th percentile
  const p10A = sorted10Pct(ra);
  const p10B = sorted10Pct(rb);
  const tailLossCorrelation = pearsonCorrelation(p10A, p10B);

  return {
    strategyA: a.strategyId,
    strategyB: b.strategyId,
    returnCorrelation,
    signalCorrelation,
    tradeOverlap: tradeOverlapVal,
    drawdownCorrelation,
    tailLossCorrelation,
  };
}

function sorted10Pct(returns: number[]): number[] {
  if (returns.length < 20) return returns;
  const n10 = Math.floor(returns.length * 0.1);
  const sorted = [...returns].sort((a, b) => a - b);
  return sorted.slice(0, n10);
}

// ─── Full Correlation Matrix ──────────────────────────────────────────────────

/**
 * Build the full N×N return correlation matrix for all strategies.
 */
export function buildCorrelationMatrix(
  series: StrategyReturnSeries[],
  categoryMap: Map<string, StrategyCategory>,
  correlationThreshold: number = 0.70,
): CorrelationMatrix {
  const n = series.length;
  const strategies = series.map((s) => s.strategyId);

  // Build N×N matrix
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const pairs: StrategyPairCorrelation[] = [];

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const pair = computePairCorrelation(series[i], series[j]);
      matrix[i][j] = pair.returnCorrelation;
      matrix[j][i] = pair.returnCorrelation;
      pairs.push(pair);
    }
  }

  // Hierarchical clustering with average linkage
  const clusters = clusterStrategies(strategies, matrix, categoryMap, correlationThreshold);

  return {
    strategies,
    matrix,
    clusters,
    computedAt: new Date().toISOString(),
  };
}

// ─── Hierarchical Clustering ──────────────────────────────────────────────────

/**
 * Simple greedy clustering: group strategies that are all mutually
 * correlated above `threshold`.
 *
 * For a production system with many strategies, use proper average-linkage
 * hierarchical clustering. This greedy version is sufficient for ≤ 20 strategies.
 */
export function clusterStrategies(
  strategies: string[],
  matrix: number[][],
  categoryMap: Map<string, StrategyCategory>,
  threshold: number,
): StrategyCluster[] {
  const n = strategies.length;
  const assigned = new Set<number>();
  const clusters: StrategyCluster[] = [];
  let clusterId = 0;

  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;

    const members = [i];
    assigned.add(i);

    for (let j = i + 1; j < n; j++) {
      if (assigned.has(j)) continue;
      // Check if j is correlated with ALL existing members (complete linkage)
      const allAbove = members.every((m) => Math.abs(matrix[m][j]) >= threshold);
      if (allAbove) {
        members.push(j);
        assigned.add(j);
      }
    }

    if (members.length > 1) {
      // Compute average intra-cluster correlation
      let sum = 0;
      let count = 0;
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          sum += Math.abs(matrix[members[a]][members[b]]);
          count++;
        }
      }
      const avgCorr = count > 0 ? sum / count : 0;

      const memberIds = members.map((m) => strategies[m]);
      const categories = memberIds.map((id) => categoryMap.get(id) ?? "STATISTICAL");
      const dominantCategory = mostCommon(categories) as StrategyCategory;

      // Capital cap: cluster gets at most 30% of portfolio capital
      // (further reduced for larger clusters)
      const allocationCap = Math.max(10, 30 - (members.length - 2) * 5);

      clusters.push({
        clusterId: `cluster-${clusterId++}`,
        clusterLabel: `${dominantCategory} cluster (${memberIds.join(", ")})`,
        strategies: memberIds,
        avgIntraCorrelation: avgCorr,
        dominantCategory,
        allocationCapPct: allocationCap,
        computedAt: new Date().toISOString(),
      });
    } else {
      // Singleton cluster — no capital constraint beyond individual limits
      const id = strategies[i];
      clusters.push({
        clusterId: `cluster-${clusterId++}`,
        clusterLabel: `${id} (singleton)`,
        strategies: [id],
        avgIntraCorrelation: 1,
        dominantCategory: categoryMap.get(id) ?? "STATISTICAL",
        allocationCapPct: 25,
        computedAt: new Date().toISOString(),
      });
    }
  }

  return clusters;
}

function mostCommon<T>(arr: T[]): T {
  const counts = new Map<T, number>();
  for (const item of arr) counts.set(item, (counts.get(item) ?? 0) + 1);
  let maxCount = 0;
  let maxItem = arr[0];
  for (const [item, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxItem = item;
    }
  }
  return maxItem;
}
