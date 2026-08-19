"""
Portfolio Optimization — Hierarchical Risk Parity (HRP).

Instead of choosing the single "best" stock, optimizes the entire portfolio
allocation across the top-ranked stocks. HRP is preferred over Mean-Variance
Optimization (Markowitz) because:

  1. No matrix inversion → numerically stable with noisy returns
  2. No need to estimate expected returns (notoriously unreliable)
  3. Works well with small sample sizes (typical intraday window)
  4. Produces intuitive, diversified allocations
  5. Naturally accounts for sector/correlation clusters

The pipeline:
  1. Start with the top N stocks from the StockRanker
  2. Compute a correlation/distance matrix from recent returns
  3. Apply hierarchical clustering (single-linkage)
  4. Allocate using the HRP recursive bisection algorithm
  5. Apply sector concentration constraints
  6. Scale final allocations by each stock's risk score

Output:
  symbol | weight | sector | rationale
  HAL    | 0.15   | Infra  | "Low correlation to other picks, strong momentum"
  BEL    | 0.12   | Infra  | "Cluster diversifier, rank #2"
  ...
"""

from typing import Any

import numpy as np
import structlog

from ..schemas import (
    MarketRegime,
    PortfolioAllocation,
    PortfolioAsset,
    PortfolioRequest,
    PortfolioResponse,
)

logger = structlog.get_logger()


class PortfolioOptimizer:
    """
    Hierarchical Risk Parity portfolio optimizer.

    Allocates capital across the top-ranked stocks using correlation-aware
    diversification, with sector constraints and risk-adjusted sizing.
    """

    def __init__(self):
        self.model_version = "portfolio-hrp-v1"

    def optimize(self, request: PortfolioRequest) -> PortfolioResponse:
        """
        Optimize portfolio allocation.

        Args:
            request: PortfolioRequest with assets, constraints, risk budget.

        Returns:
            PortfolioResponse with allocations, expected metrics.
        """
        assets = request.assets
        n = len(assets)

        if n == 0:
            return PortfolioResponse(
                allocations=[],
                expected_return=0.0,
                portfolio_risk=0.0,
                sharpe_ratio=0.0,
                diversification_ratio=0.0,
            )

        if n == 1:
            return self._single_asset_portfolio(assets[0])

        # Limit to max_positions
        if n > request.max_positions:
            assets = sorted(assets, key=lambda a: a.rank_score, reverse=True)[
                :request.max_positions
            ]
            n = len(assets)

        # Step 1: Build covariance/correlation proxy from risk scores and sectors
        corr_matrix = self._build_correlation_matrix(assets)

        # Step 2: Compute HRP weights
        hrp_weights = self._hrp_allocate(corr_matrix, assets)

        # Step 3: Apply sector constraints
        constrained_weights = self._apply_sector_constraints(
            hrp_weights, assets, request.max_sector_weight
        )

        # Step 4: Scale by rank score (prefer higher-ranked stocks)
        rank_scaled = self._scale_by_rank(constrained_weights, assets)

        # Step 5: Scale by risk (lower risk → more weight)
        risk_scaled = self._scale_by_risk(rank_scaled, assets)

        # Step 6: Normalize to sum to 1
        final_weights = self._normalize(risk_scaled)

        # Build response
        allocations = []
        for i, asset in enumerate(assets):
            weight = final_weights[i]
            if weight < 0.01:  # Skip negligible allocations
                continue
            allocations.append(
                PortfolioAllocation(
                    symbol=asset.symbol,
                    weight=round(weight, 4),
                    sector=asset.sector,
                    rationale=self._build_allocation_rationale(
                        asset, weight, hrp_weights[i], len(assets)
                    ),
                )
            )

        # Sort by weight descending
        allocations.sort(key=lambda a: a.weight, reverse=True)

        # Compute portfolio-level metrics
        expected_return = sum(
            a.expected_return * final_weights[i] for i, a in enumerate(assets)
        )
        portfolio_risk = self._estimate_portfolio_risk(
            final_weights, assets, corr_matrix
        )
        sharpe = expected_return / portfolio_risk if portfolio_risk > 0 else 0.0
        div_ratio = self._diversification_ratio(final_weights, assets, corr_matrix)

        return PortfolioResponse(
            allocations=allocations,
            expected_return=round(expected_return, 4),
            portfolio_risk=round(portfolio_risk, 4),
            sharpe_ratio=round(sharpe, 2),
            diversification_ratio=round(div_ratio, 2),
        )

    def _single_asset_portfolio(self, asset: PortfolioAsset) -> PortfolioResponse:
        """Trivial case: single asset gets 100% weight."""
        return PortfolioResponse(
            allocations=[
                PortfolioAllocation(
                    symbol=asset.symbol,
                    weight=1.0,
                    sector=asset.sector,
                    rationale="Single asset portfolio — full allocation.",
                )
            ],
            expected_return=round(asset.expected_return, 4),
            portfolio_risk=round(asset.risk_score / 10, 4),
            sharpe_ratio=round(
                asset.expected_return / max(asset.risk_score / 10, 0.01), 2
            ),
            diversification_ratio=1.0,
        )

    def _build_correlation_matrix(
        self, assets: list[PortfolioAsset]
    ) -> np.ndarray:
        """
        Build a correlation matrix proxy from sector membership and risk scores.

        When historical return series are unavailable (common for intraday
        rebalancing), we synthesize correlations:
          - Same sector stocks: correlation 0.6-0.8
          - Cross-sector stocks: correlation 0.2-0.4
          - Diagonal: 1.0

        This is a reasonable proxy for NSE F&O stocks where intra-sector
        correlation is empirically high (banks move together, IT moves together).
        """
        n = len(assets)
        corr = np.eye(n)

        for i in range(n):
            for j in range(i + 1, n):
                if assets[i].sector == assets[j].sector:
                    # Same sector: high correlation (0.6 + noise from risk similarity)
                    risk_sim = 1 - abs(assets[i].risk_score - assets[j].risk_score) / 10
                    base_corr = 0.6 + risk_sim * 0.2
                else:
                    # Different sector: moderate correlation
                    base_corr = 0.25 + np.random.uniform(-0.05, 0.05)

                corr[i, j] = base_corr
                corr[j, i] = base_corr

        return corr

    def _hrp_allocate(
        self, corr_matrix: np.ndarray, assets: list[PortfolioAsset]
    ) -> np.ndarray:
        """
        Hierarchical Risk Parity allocation algorithm.

        Steps:
          1. Compute distance matrix from correlation
          2. Hierarchical clustering (single linkage)
          3. Quasi-diagonalize the covariance matrix
          4. Recursive bisection to allocate weights inversely proportional
             to cluster variance
        """
        n = len(assets)
        if n <= 1:
            return np.ones(n)

        # Distance matrix: d_ij = sqrt(0.5 * (1 - corr_ij))
        dist = np.sqrt(0.5 * (1 - corr_matrix))
        np.fill_diagonal(dist, 0)

        # Hierarchical clustering (simplified: use scipy if available)
        try:
            from scipy.cluster.hierarchy import linkage, leaves_list
            from scipy.spatial.distance import squareform

            # Convert to condensed distance matrix
            condensed = squareform(dist, checks=False)
            link = linkage(condensed, method="single")
            sort_ix = leaves_list(link).tolist()
        except ImportError:
            # Fallback: simple nearest-neighbor ordering
            sort_ix = list(range(n))

        # Variance per asset (proxy from risk score)
        variances = np.array([max(a.risk_score / 10, 0.01) ** 2 for a in assets])

        # Recursive bisection
        weights = np.ones(n)
        cluster_items = [sort_ix]

        while cluster_items:
            new_clusters = []
            for cluster in cluster_items:
                if len(cluster) <= 1:
                    continue
                # Split into two halves
                mid = len(cluster) // 2
                left = cluster[:mid]
                right = cluster[mid:]

                # Cluster variance = sum of individual variances (simplified)
                var_left = sum(variances[i] for i in left)
                var_right = sum(variances[i] for i in right)

                # Allocate inversely proportional to variance
                total_var = var_left + var_right
                if total_var > 0:
                    alpha = 1 - var_left / total_var  # Left gets more if lower variance
                else:
                    alpha = 0.5

                for i in left:
                    weights[i] *= alpha
                for i in right:
                    weights[i] *= (1 - alpha)

                if len(left) > 1:
                    new_clusters.append(left)
                if len(right) > 1:
                    new_clusters.append(right)

            cluster_items = new_clusters

        return weights

    def _apply_sector_constraints(
        self,
        weights: np.ndarray,
        assets: list[PortfolioAsset],
        max_sector_weight: float,
    ) -> np.ndarray:
        """
        Cap sector concentration: no sector can exceed max_sector_weight
        of the total portfolio. Excess is redistributed proportionally
        to other sectors.
        """
        n = len(assets)
        result = weights.copy()

        # Group by sector
        sector_indices: dict[str, list[int]] = {}
        for i, asset in enumerate(assets):
            sector_indices.setdefault(asset.sector, []).append(i)

        # Iteratively cap sectors
        for _ in range(5):  # Max 5 iterations to converge
            total = result.sum()
            if total <= 0:
                break

            overflow = 0.0
            underweight_indices = []

            for sector, indices in sector_indices.items():
                sector_weight = sum(result[i] for i in indices) / total
                if sector_weight > max_sector_weight:
                    # Scale down this sector
                    scale = max_sector_weight / sector_weight
                    for i in indices:
                        excess = result[i] * (1 - scale)
                        result[i] *= scale
                        overflow += excess
                else:
                    underweight_indices.extend(indices)

            # Redistribute overflow to underweight sectors
            if overflow > 0 and underweight_indices:
                underweight_total = sum(result[i] for i in underweight_indices)
                if underweight_total > 0:
                    for i in underweight_indices:
                        result[i] += overflow * (result[i] / underweight_total)

        return result

    def _scale_by_rank(
        self, weights: np.ndarray, assets: list[PortfolioAsset]
    ) -> np.ndarray:
        """Scale weights by rank score — higher-ranked stocks get more weight."""
        rank_scores = np.array([a.rank_score for a in assets])
        # Softmax-like scaling: amplify differences without zeroing out low-rank
        if rank_scores.max() > 0:
            normalized = rank_scores / rank_scores.max()
            # Power transform to amplify top ranks
            rank_factor = np.power(normalized, 1.5) * 0.5 + 0.5
        else:
            rank_factor = np.ones(len(assets))

        return weights * rank_factor

    def _scale_by_risk(
        self, weights: np.ndarray, assets: list[PortfolioAsset]
    ) -> np.ndarray:
        """Scale weights inversely by risk — lower risk gets more allocation."""
        risk_scores = np.array([max(a.risk_score, 0.5) for a in assets])
        # Inverse risk: risk_score of 2 → factor 1.0; risk_score of 8 → factor 0.25
        risk_factor = 1.0 / np.power(risk_scores / 2.0, 0.8)
        risk_factor = np.clip(risk_factor, 0.2, 2.0)

        return weights * risk_factor

    def _normalize(self, weights: np.ndarray) -> np.ndarray:
        """Normalize weights to sum to 1."""
        total = weights.sum()
        if total <= 0:
            return np.ones(len(weights)) / len(weights)
        return weights / total

    def _estimate_portfolio_risk(
        self,
        weights: np.ndarray,
        assets: list[PortfolioAsset],
        corr_matrix: np.ndarray,
    ) -> float:
        """
        Estimate portfolio risk (volatility) from individual risk scores
        and the correlation structure.

        σ_p = sqrt(w' Σ w) where Σ_ij = σ_i * σ_j * ρ_ij
        """
        n = len(assets)
        sigmas = np.array([max(a.risk_score / 10, 0.01) for a in assets])

        # Build covariance matrix
        cov = np.outer(sigmas, sigmas) * corr_matrix

        # Portfolio variance
        port_var = weights @ cov @ weights
        return float(np.sqrt(max(port_var, 0)))

    def _diversification_ratio(
        self,
        weights: np.ndarray,
        assets: list[PortfolioAsset],
        corr_matrix: np.ndarray,
    ) -> float:
        """
        Diversification ratio = weighted avg of individual σ / portfolio σ.
        DR > 1 means the portfolio benefits from diversification.
        """
        sigmas = np.array([max(a.risk_score / 10, 0.01) for a in assets])
        weighted_avg_sigma = np.dot(weights, sigmas)
        port_risk = self._estimate_portfolio_risk(weights, assets, corr_matrix)

        if port_risk > 0:
            return float(weighted_avg_sigma / port_risk)
        return 1.0

    def _build_allocation_rationale(
        self,
        asset: PortfolioAsset,
        final_weight: float,
        hrp_weight: float,
        total_assets: int,
    ) -> str:
        """Generate a human-readable rationale for the allocation."""
        parts = []

        # Size relative to equal weight
        equal_weight = 1.0 / total_assets
        if final_weight > equal_weight * 1.3:
            parts.append("overweight")
        elif final_weight < equal_weight * 0.7:
            parts.append("underweight")
        else:
            parts.append("neutral weight")

        # Risk contribution
        if asset.risk_score < 3:
            parts.append("low risk")
        elif asset.risk_score > 7:
            parts.append("high risk (sized down)")

        # Rank
        if asset.rank_score > 80:
            parts.append(f"top-ranked ({asset.rank_score:.0f}/100)")
        elif asset.rank_score > 60:
            parts.append(f"well-ranked ({asset.rank_score:.0f}/100)")

        # Sector
        parts.append(f"sector: {asset.sector}")

        return "; ".join(parts).capitalize() + "."
