"""
Phase 3E — Cross-Sectional Alpha & Ranking Engine.

Public surface:

    from src.ranking.schemas import CrossSectionalAlphaSignal, RankingRow
    from src.ranking.universe import UniverseResolver, EligibilityState
    from src.ranking.normalization import cross_sectional_normalize, winsorize
    from src.ranking.neutralization import sector_neutralize, beta_neutralize
    from src.ranking.evaluation import (
        compute_rank_ic, compute_ic_series, compute_decile_report,
        compute_turnover_proxy, compare_rankers,
    )
    from src.ranking.ranker import (
        MomentumBaselineRanker, CompositeBaselineRanker,
        RidgeRanker, ElasticNetRanker, LightGBMRanker, XGBoostRanker,
        fit_and_evaluate,
    )
    from src.ranking.walk_forward import CrossSectionalWalkForward
"""
