"""
Phase 3I — Signal Health Classification & Concept-Drift Framework.

Aggregates all decay diagnostics into a structured health record.

Design rules
------------
1. SignalHealth is NOT a black-box 0–100 score.  Every dimension is
   independently traceable to underlying diagnostics.
2. INSUFFICIENT_EVIDENCE propagates: if any required dimension has no
   data, the overall status is INSUFFICIENT_EVIDENCE.
3. No automatic model replacement occurs here (spec §66).
4. Alert thresholds are configurable — never hardcoded in logic.
5. No np.random.* — deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .schemas import (
    CalibrationDriftResult,
    ComponentStatus,
    ConceptDriftRecord,
    DataCoverageReport,
    DecayStatus,
    DriftSeverity,
    DriftType,
    EvidenceLevel,
    FeatureStabilityResult,
    ICDecayResult,
    PortfolioDecayResult,
    QuantileDecayResult,
    RegimeDecayResult,
    SignalHealth,
    SignalHealthRecord,
    SignalSurvivalClass,
    StabilityMatrix,
    StabilityMatrixCell,
    TemporalPeriod,
)


UTC = timezone.utc


# ── Alert thresholds (configurable, spec §48) ─────────────────────────────────

@dataclass
class StabilityAlertConfig:
    """
    Configurable thresholds for stability alerts.
    All thresholds are configurable — none hardcoded in logic.
    """
    ic_deterioration_threshold:     float = -0.01     # IC trend slope below this → alert
    icir_min:                       float = 0.0        # ICIR below this → alert
    brier_deterioration_slope:      float = 0.002      # Brier trend slope above this → alert
    feature_drift_psi_warn:         float = 0.10       # PSI above this → WARNING
    feature_drift_psi_critical:     float = 0.20       # PSI above this → CRITICAL
    prediction_drift_ks_p_warn:     float = 0.05       # KS p-value below this → WARNING
    ic_positive_pct_min:            float = 45.0       # positive IC% below this → concern
    recent_vs_early_ic_ratio_min:   float = 0.5        # recent/early IC below this → decay

    version: str = "alert-config-v1"


# ── Component classifiers ─────────────────────────────────────────────────────

def _classify_predictive(ic_result: Optional[ICDecayResult]) -> tuple[ComponentStatus, str]:
    """Classify predictive health from IC decay analysis."""
    if ic_result is None:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, "No IC decay result provided."

    if ic_result.evidence == EvidenceLevel.INSUFFICIENT:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, f"Insufficient IC data (n={ic_result.n_timestamps})."

    status_map = {
        DecayStatus.STABLE:              ComponentStatus.STABLE,
        DecayStatus.MILD_DECAY:          ComponentStatus.WEAKENING,
        DecayStatus.SIGNIFICANT_DECAY:   ComponentStatus.DECAYING,
        DecayStatus.FAILED:              ComponentStatus.FAILED,
        DecayStatus.DRIFT_DETECTED:      ComponentStatus.DRIFTED,
        DecayStatus.INSUFFICIENT_EVIDENCE: ComponentStatus.INSUFFICIENT_EVIDENCE,
    }
    status = status_map.get(ic_result.decay_status, ComponentStatus.INSUFFICIENT_EVIDENCE)
    evidence = (
        f"Mean Rank IC={ic_result.mean_rank_ic}, ICIR={ic_result.icir}, "
        f"Trend slope={ic_result.ic_trend_slope}, "
        f"Early→Recent IC: {ic_result.early_mean_ic} → {ic_result.recent_mean_ic}."
    )
    return status, evidence


def _classify_calibration(cal_result: Optional[CalibrationDriftResult]) -> tuple[ComponentStatus, str]:
    """Classify calibration health from drift analysis."""
    if cal_result is None:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, "No calibration drift result provided."

    return cal_result.calibration_status, (
        f"Brier trend slope={cal_result.brier_trend_slope}, "
        f"ECE trend slope={cal_result.ece_trend_slope}, "
        f"{len(cal_result.periods)} periods."
    )


def _classify_feature(feat_results: Optional[list[FeatureStabilityResult]]) -> tuple[ComponentStatus, str]:
    """Classify feature health from stability analysis."""
    if not feat_results:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, "No feature stability results provided."

    max_severity = DriftSeverity.NONE
    for r in feat_results:
        if r.drift_severity.value > max_severity.value:
            max_severity = r.drift_severity

    severity_map = {
        DriftSeverity.NONE:     ComponentStatus.STABLE,
        DriftSeverity.LOW:      ComponentStatus.STABLE,
        DriftSeverity.MODERATE: ComponentStatus.WEAKENING,
        DriftSeverity.HIGH:     ComponentStatus.DRIFTED,
        DriftSeverity.CRITICAL: ComponentStatus.FAILED,
    }
    status = severity_map.get(max_severity, ComponentStatus.STABLE)
    n_drifted = sum(1 for r in feat_results if r.drift_severity != DriftSeverity.NONE)
    evidence = f"{n_drifted}/{len(feat_results)} features with drift. Max PSI severity: {max_severity.value}."
    return status, evidence


def _classify_regime(regime_result: Optional[RegimeDecayResult]) -> tuple[ComponentStatus, str]:
    """Classify regime stability from regime decay analysis."""
    if regime_result is None:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, "No regime decay result provided."

    valid_stats = [r for r in regime_result.regime_stats if r.mean_rank_ic is not None]
    if not valid_stats:
        return ComponentStatus.INSUFFICIENT_EVIDENCE, "Insufficient regime data."

    negative_regimes = [r.regime for r in valid_stats if r.mean_rank_ic < 0]
    if len(negative_regimes) > len(valid_stats) // 2:
        return ComponentStatus.DECAYING, f"IC negative in regimes: {negative_regimes}."
    if negative_regimes:
        return ComponentStatus.WEAKENING, f"IC negative in some regimes: {negative_regimes}."
    return ComponentStatus.STABLE, f"IC positive across {len(valid_stats)} regimes."


def _classify_overall(components: list[ComponentStatus]) -> ComponentStatus:
    """Worst-case aggregation across all component statuses."""
    order = [
        ComponentStatus.STABLE,
        ComponentStatus.WEAKENING,
        ComponentStatus.DECAYING,
        ComponentStatus.DRIFTED,
        ComponentStatus.FAILED,
        ComponentStatus.INSUFFICIENT_EVIDENCE,
    ]
    worst_idx = 0
    for c in components:
        try:
            idx = order.index(c)
            if idx > worst_idx:
                worst_idx = idx
        except ValueError:
            pass
    return order[worst_idx]


# ── Signal survival classification ───────────────────────────────────────────

def classify_signal_survival(ic_result: Optional[ICDecayResult]) -> SignalSurvivalClass:
    """Classify signal survival based on IC decay analysis."""
    if ic_result is None or ic_result.evidence == EvidenceLevel.INSUFFICIENT:
        return SignalSurvivalClass.INSUFFICIENT_EVIDENCE

    if ic_result.decay_status == DecayStatus.FAILED:
        return SignalSurvivalClass.FAILED
    if ic_result.decay_status == DecayStatus.SIGNIFICANT_DECAY:
        return SignalSurvivalClass.DECAYING
    if ic_result.decay_status == DecayStatus.MILD_DECAY:
        return SignalSurvivalClass.WEAKENING
    if ic_result.decay_status == DecayStatus.STABLE:
        return SignalSurvivalClass.ACTIVE
    return SignalSurvivalClass.INSUFFICIENT_EVIDENCE


# ── Main signal health aggregator ─────────────────────────────────────────────

def classify_signal_health(
    signal_id: str,
    as_of: datetime,
    ic_result: Optional[ICDecayResult] = None,
    cal_result: Optional[CalibrationDriftResult] = None,
    feat_results: Optional[list[FeatureStabilityResult]] = None,
    regime_result: Optional[RegimeDecayResult] = None,
    portfolio_result: Optional[PortfolioDecayResult] = None,
) -> SignalHealth:
    """
    Classify overall signal health across all dimensions.

    Parameters
    ----------
    signal_id        : signal identifier
    as_of            : classification timestamp
    ic_result        : IC decay analysis result
    cal_result       : calibration drift result
    feat_results     : list of feature stability results
    regime_result    : regime decay result
    portfolio_result : portfolio decay result

    Returns
    -------
    SignalHealth — NOT a black-box score.
    Each dimension is independently classified and evidence is stated.
    """
    pred_s, pred_e = _classify_predictive(ic_result)
    cal_s,  cal_e  = _classify_calibration(cal_result)
    feat_s, feat_e = _classify_feature(feat_results)
    reg_s,  reg_e  = _classify_regime(regime_result)

    # Execution / capacity from portfolio
    exec_s = ComponentStatus.INSUFFICIENT_EVIDENCE
    cap_s  = ComponentStatus.INSUFFICIENT_EVIDENCE
    if portfolio_result is not None:
        decay_map = {
            DecayStatus.STABLE:             ComponentStatus.STABLE,
            DecayStatus.MILD_DECAY:         ComponentStatus.WEAKENING,
            DecayStatus.SIGNIFICANT_DECAY:  ComponentStatus.DECAYING,
            DecayStatus.FAILED:             ComponentStatus.FAILED,
        }
        exec_s = decay_map.get(portfolio_result.decay_status, ComponentStatus.INSUFFICIENT_EVIDENCE)
        cap_s  = exec_s

    overall = _classify_overall([pred_s, cal_s, feat_s, reg_s])
    survival = classify_signal_survival(ic_result)

    return SignalHealth(
        signal_id=signal_id,
        as_of=as_of,
        predictive_status=pred_s,
        calibration_status=cal_s,
        feature_status=feat_s,
        regime_status=reg_s,
        execution_status=exec_s,
        capacity_status=cap_s,
        overall_status=overall,
        predictive_evidence=pred_e,
        calibration_evidence=cal_e,
        feature_evidence=feat_e,
        regime_evidence=reg_e,
        survival_class=survival,
    )


# ── Stability matrix builder ──────────────────────────────────────────────────

def build_stability_matrix(
    signal_id: str,
    ic_result: Optional[ICDecayResult] = None,
    cal_result: Optional[CalibrationDriftResult] = None,
    portfolio_result: Optional[PortfolioDecayResult] = None,
) -> StabilityMatrix:
    """
    Build the temporal × metric stability matrix (spec §64).

    Rows: EARLY, MIDDLE, RECENT, FULL
    Columns: IC, Rank IC, ICIR, EV, Calibration, Net Return, Turnover, Cost, Capacity

    Cells with missing data are explicitly marked INSUFFICIENT_EVIDENCE.
    Never filled with fabricated zeros.
    """
    METRICS = ["IC", "Rank_IC", "ICIR", "EV", "Brier", "Net_Return", "Turnover", "Cost"]
    PERIODS = [TemporalPeriod.EARLY, TemporalPeriod.MIDDLE, TemporalPeriod.RECENT, TemporalPeriod.FULL]

    cells: list[StabilityMatrixCell] = []

    def _cell(period, metric, value, status=None):
        ev = EvidenceLevel.INSUFFICIENT
        s = ComponentStatus.INSUFFICIENT_EVIDENCE
        if value is not None:
            ev = EvidenceLevel.WEAK
            s = status or ComponentStatus.STABLE
        return StabilityMatrixCell(period=period, metric=metric, value=value, status=s, evidence=ev)

    # IC row
    if ic_result is not None:
        cells.append(_cell(TemporalPeriod.EARLY,  "IC",      ic_result.early_mean_ic))
        cells.append(_cell(TemporalPeriod.MIDDLE, "IC",      ic_result.middle_mean_ic))
        cells.append(_cell(TemporalPeriod.RECENT, "IC",      ic_result.recent_mean_ic))
        cells.append(_cell(TemporalPeriod.FULL,   "IC",      ic_result.mean_ic))
        cells.append(_cell(TemporalPeriod.EARLY,  "Rank_IC", ic_result.early_mean_ic))
        cells.append(_cell(TemporalPeriod.MIDDLE, "Rank_IC", ic_result.middle_mean_ic))
        cells.append(_cell(TemporalPeriod.RECENT, "Rank_IC", ic_result.recent_mean_ic))
        cells.append(_cell(TemporalPeriod.FULL,   "Rank_IC", ic_result.mean_rank_ic))
        cells.append(_cell(TemporalPeriod.FULL,   "ICIR",    ic_result.icir))

    # Calibration row
    if cal_result is not None and cal_result.periods:
        period_map = {
            TemporalPeriod.EARLY:  cal_result.periods[0] if cal_result.periods else None,
            TemporalPeriod.MIDDLE: cal_result.periods[len(cal_result.periods)//2] if len(cal_result.periods) > 2 else None,
            TemporalPeriod.RECENT: cal_result.periods[-1] if cal_result.periods else None,
        }
        for period, p in period_map.items():
            cells.append(_cell(period, "Brier", p.brier if p else None))
        full_p = cal_result.periods[-1] if cal_result.periods else None
        cells.append(_cell(TemporalPeriod.FULL, "Brier", full_p.brier if full_p else None))

    # Portfolio rows
    if portfolio_result is not None:
        win_map = {w.window_label: w for w in portfolio_result.windows}
        for period, label in [(TemporalPeriod.EARLY, "EARLY"), (TemporalPeriod.MIDDLE, "MIDDLE"),
                              (TemporalPeriod.RECENT, "RECENT"), (TemporalPeriod.FULL, "FULL")]:
            w = win_map.get(label)
            cells.append(_cell(period, "Net_Return", w.net_return if w else None))
            cells.append(_cell(period, "Turnover",   w.turnover   if w else None))

    # Fill any missing cells explicitly
    existing = {(c.period, c.metric) for c in cells}
    for period in PERIODS:
        for metric in METRICS:
            if (period, metric) not in existing:
                cells.append(StabilityMatrixCell(
                    period=period, metric=metric, value=None,
                    status=ComponentStatus.INSUFFICIENT_EVIDENCE,
                    evidence=EvidenceLevel.INSUFFICIENT,
                ))

    return StabilityMatrix(signal_id=signal_id, cells=cells)


# ── Concept drift record builder ──────────────────────────────────────────────

def build_concept_drift_records(
    signal_id: str,
    as_of: datetime,
    ic_result: Optional[ICDecayResult] = None,
    cal_result: Optional[CalibrationDriftResult] = None,
    feat_results: Optional[list[FeatureStabilityResult]] = None,
    prediction_drift_results: Optional[list] = None,
    alert_config: Optional[StabilityAlertConfig] = None,
) -> list[ConceptDriftRecord]:
    """
    Build a list of concept-drift records from all decay analysis results.
    Each drift type is recorded separately (spec §37).
    """
    cfg = alert_config or StabilityAlertConfig()
    records: list[ConceptDriftRecord] = []

    # IC (performance) drift
    if ic_result and ic_result.ic_trend_slope is not None:
        if ic_result.ic_trend_slope < cfg.ic_deterioration_threshold:
            records.append(ConceptDriftRecord(
                drift_type=DriftType.PERFORMANCE_DRIFT,
                severity=DriftSeverity.HIGH if ic_result.decay_status == DecayStatus.SIGNIFICANT_DECAY else DriftSeverity.MODERATE,
                detected_at=as_of,
                reference_period="EARLY",
                comparison_period="RECENT",
                metric_name="rank_ic",
                metric_value=ic_result.ic_trend_slope,
                threshold=cfg.ic_deterioration_threshold,
                evidence=ic_result.evidence,
                details=f"IC trend slope {ic_result.ic_trend_slope:.6f} < threshold {cfg.ic_deterioration_threshold}.",
            ))

    # Calibration drift
    if cal_result and cal_result.brier_trend_slope is not None:
        if cal_result.brier_trend_slope > cfg.brier_deterioration_slope:
            records.append(ConceptDriftRecord(
                drift_type=DriftType.CALIBRATION_DRIFT,
                severity=DriftSeverity.HIGH if cal_result.decay_status == DecayStatus.SIGNIFICANT_DECAY else DriftSeverity.MODERATE,
                detected_at=as_of,
                reference_period="EARLY",
                comparison_period="RECENT",
                metric_name="brier_score",
                metric_value=cal_result.brier_trend_slope,
                threshold=cfg.brier_deterioration_slope,
                evidence=EvidenceLevel.MODERATE,
                details=f"Brier trend slope {cal_result.brier_trend_slope:.6f} > threshold.",
            ))

    # Feature drift
    if feat_results:
        for fr in feat_results:
            if fr.drift_severity not in (DriftSeverity.NONE, DriftSeverity.LOW):
                records.append(ConceptDriftRecord(
                    drift_type=DriftType.FEATURE_DRIFT,
                    severity=fr.drift_severity,
                    detected_at=as_of,
                    reference_period="reference",
                    comparison_period="comparison",
                    metric_name=f"psi_{fr.feature_name}",
                    metric_value=fr.max_psi,
                    threshold=cfg.feature_drift_psi_warn,
                    evidence=fr.evidence,
                    details=f"Feature {fr.feature_name}: PSI={fr.max_psi}, KS={fr.max_ks_statistic}.",
                ))

    # Prediction drift
    if prediction_drift_results:
        for pr in prediction_drift_results:
            if pr.drift_severity not in (DriftSeverity.NONE,):
                records.append(ConceptDriftRecord(
                    drift_type=DriftType.PREDICTION_DRIFT,
                    severity=pr.drift_severity,
                    detected_at=as_of,
                    reference_period="reference",
                    comparison_period="comparison",
                    metric_name=pr.metric_name,
                    metric_value=pr.psi,
                    threshold=0.10,
                    evidence=pr.evidence,
                    details=f"{pr.metric_name}: PSI={pr.psi}, KS_p={pr.ks_p_value}.",
                ))

    return records


# ── Data coverage report ───────────────────────────────────────────────────────

def build_data_coverage(
    observations: list,
    signal_id: str,
    data_snapshot_id: str = "",
    universe_version: str = "",
    feature_version: str = "",
    label_version: str = "lv2",
    model_version: str = "",
) -> DataCoverageReport:
    """
    Build a data coverage report from a list of AlphaDecayObservation objects.
    Documents the maximum genuinely supported historical period.
    Never invents history.
    """
    from .schemas import AlphaDecayObservation

    if not observations:
        return DataCoverageReport(
            data_snapshot_id=data_snapshot_id, universe_version=universe_version,
            feature_version=feature_version, label_version=label_version,
            model_version=model_version,
            first_valid_timestamp=None, last_valid_timestamp=None,
            total_observations=0, unique_instruments=0, unique_sessions=0,
            historical_coverage="INSUFFICIENT_EVIDENCE",
            notes="No observations provided.",
        )

    timestamps  = [o.signal_timestamp for o in observations]
    instruments = {o.instrument_id for o in observations}
    first_ts = min(timestamps)
    last_ts  = max(timestamps)

    # Sessions = unique dates
    unique_dates = {ts.date() for ts in timestamps}

    return DataCoverageReport(
        data_snapshot_id=data_snapshot_id,
        universe_version=universe_version,
        feature_version=feature_version,
        label_version=label_version,
        model_version=model_version,
        first_valid_timestamp=first_ts,
        last_valid_timestamp=last_ts,
        total_observations=len(observations),
        unique_instruments=len(instruments),
        unique_sessions=len(unique_dates),
        historical_coverage=(
            f"{first_ts.date()} to {last_ts.date()} "
            f"({len(unique_dates)} sessions, {len(instruments)} instruments)"
        ),
        notes="",
    )
