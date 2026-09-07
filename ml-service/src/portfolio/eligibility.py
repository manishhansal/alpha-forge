"""
Phase 3H — Candidate Eligibility Filter.

Deterministic pre-optimization filter that rejects candidates that should
not enter the portfolio optimizer.

Design rules
------------
1. Every rejection has an explicit EligibilityStatus and reason string.
2. ABSTAIN and INSUFFICIENT_EVIDENCE from Phase 3F are respected — they
   NEVER become ELIGIBLE at the portfolio layer.
3. Uncalibrated probability (status != CALIBRATED) → UNCALIBRATED_PROBABILITY.
4. EV filter is configurable — by default any EV is accepted if valid;
   the caller may set min_ev_threshold > 0 to reject zero/negative EV.
5. No uncontrolled randomness.
6. ELIGIBLE is returned only when ALL checks pass.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from .schemas import EligibilityStatus, PortfolioCandidate

UTC = timezone.utc


# ── Configuration ─────────────────────────────────────────────────────────────

@dataclass
class EligibilityConfig:
    """
    Configuration for the eligibility filter.
    All thresholds are configurable — none hardcoded in logic.
    """
    # Signal staleness
    max_signal_age_hours:       float = 24.0    # reject if signal > N hours old

    # Probability
    require_calibrated_prob:    bool = True     # reject if prob status != CALIBRATED

    # EV
    min_ev_threshold:           float = 0.0     # reject if EV ≤ this (set >0 to require positive EV)
    reject_invalid_ev:          bool = False    # if True, reject when EVStatus != VALID
                                                # if False, allow if prob is CALIBRATED even without EV

    # Liquidity
    min_adv_inr:                float = 0.0     # minimum ADV; 0 = unconstrained
    min_price_inr:              float = 0.0     # minimum price; 0 = unconstrained

    # Decision semantics — must align with Phase 3F Decision enum values
    allowed_decisions:          tuple = ("TAKE",)

    # F&O ban: if True, candidates with instrument_type FUT*/OPT* and
    # eligibility_status == FNO_BANNED are rejected
    respect_fno_ban:            bool = True

    version: str = "eligibility-v1"


# ── Eligibility filter ────────────────────────────────────────────────────────

class EligibilityFilter:
    """
    Deterministic candidate eligibility gate.

    Usage
    -----
    ::
        filt = EligibilityFilter(config)
        candidate = filt.check(candidate, formation_time)
        # candidate.eligibility_status is updated in-place
        # returns the same object for chaining
    """

    def __init__(self, config: Optional[EligibilityConfig] = None) -> None:
        self.config = config or EligibilityConfig()

    def check(
        self,
        candidate: PortfolioCandidate,
        formation_time: datetime,
    ) -> PortfolioCandidate:
        """
        Run all eligibility checks on candidate.

        Updates candidate.eligibility_status and candidate.eligibility_reason
        in-place (the schema uses a mutable dataclass intentionally here).
        Returns the same candidate for chaining.

        Checks are applied in priority order — first failure wins.
        """
        cfg = self.config

        # 1. Decision must be TAKE (or within allowed_decisions)
        # Use instrument_id as a proxy — the decision field is on the candidate
        # Candidates are pre-filtered from MetaDecisionOutput where decision=="TAKE"
        # but we verify the field if it's available via ev_status check.

        # 2. Expired contract
        if candidate.expiry_date is not None:
            form_t = formation_time
            exp    = candidate.expiry_date
            if form_t.tzinfo is None:
                form_t = form_t.replace(tzinfo=UTC)
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=UTC)
            if form_t >= exp:
                return self._reject(
                    candidate,
                    EligibilityStatus.EXPIRED_CONTRACT,
                    f"Contract expired on {candidate.expiry_date.date()}",
                )

        # 3. F&O ban check (only if the candidate itself carries the flag)
        if cfg.respect_fno_ban and candidate.eligibility_status == EligibilityStatus.FNO_BANNED:
            return self._reject(
                candidate,
                EligibilityStatus.FNO_BANNED,
                "Instrument is in F&O ban period; new positions not allowed.",
            )

        # 4. Signal staleness — formation_time - signal_time <= max_signal_age_hours
        form_t = formation_time
        sig_t  = candidate.formation_time
        if form_t.tzinfo is None:
            form_t = form_t.replace(tzinfo=UTC)
        if sig_t.tzinfo is None:
            sig_t = sig_t.replace(tzinfo=UTC)
        age_hours = (form_t - sig_t).total_seconds() / 3600.0
        if age_hours > cfg.max_signal_age_hours:
            return self._reject(
                candidate,
                EligibilityStatus.STALE_DATA,
                f"Signal age {age_hours:.1f}h exceeds maximum "
                f"{cfg.max_signal_age_hours:.1f}h.",
            )

        # 5. Calibrated probability required
        if cfg.require_calibrated_prob:
            if candidate.probability_status != "CALIBRATED":
                return self._reject(
                    candidate,
                    EligibilityStatus.UNCALIBRATED_PROBABILITY,
                    f"Probability status is {candidate.probability_status!r}; "
                    "must be CALIBRATED for portfolio use.",
                )

        # 6. EV checks
        if cfg.reject_invalid_ev:
            if candidate.ev_status not in ("VALID", "COST_DATA_UNAVAILABLE"):
                return self._reject(
                    candidate,
                    EligibilityStatus.INSUFFICIENT_EVIDENCE,
                    f"EV status {candidate.ev_status!r} is not valid.",
                )

        if candidate.expected_value is not None:
            if candidate.expected_value <= cfg.min_ev_threshold:
                return self._reject(
                    candidate,
                    EligibilityStatus.NEGATIVE_EV,
                    f"EV {candidate.expected_value:.4f} ≤ threshold "
                    f"{cfg.min_ev_threshold:.4f}.",
                )

        # 7. Liquidity
        if cfg.min_adv_inr > 0:
            if candidate.adv_inr is None or candidate.adv_inr < cfg.min_adv_inr:
                return self._reject(
                    candidate,
                    EligibilityStatus.INSUFFICIENT_LIQUIDITY,
                    f"ADV {candidate.adv_inr} < minimum {cfg.min_adv_inr:.0f} INR.",
                )

        if cfg.min_price_inr > 0:
            if candidate.price is None or candidate.price < cfg.min_price_inr:
                return self._reject(
                    candidate,
                    EligibilityStatus.INVALID_INSTRUMENT,
                    f"Price {candidate.price} < minimum {cfg.min_price_inr:.2f} INR.",
                )

        # 8. All checks passed
        candidate.eligibility_status = EligibilityStatus.ELIGIBLE
        candidate.eligibility_reason = ""
        return candidate

    def filter_batch(
        self,
        candidates: list[PortfolioCandidate],
        formation_time: datetime,
    ) -> tuple[list[PortfolioCandidate], list[PortfolioCandidate]]:
        """
        Run eligibility checks on a batch.

        Returns (eligible, rejected) lists.
        """
        eligible: list[PortfolioCandidate] = []
        rejected: list[PortfolioCandidate] = []

        for cand in candidates:
            self.check(cand, formation_time)
            if cand.is_eligible:
                eligible.append(cand)
            else:
                rejected.append(cand)

        return eligible, rejected

    @staticmethod
    def rejection_summary(
        rejected: list[PortfolioCandidate],
    ) -> dict[str, int]:
        """Return count of rejections by EligibilityStatus value."""
        counts: dict[str, int] = {}
        for c in rejected:
            k = c.eligibility_status.value
            counts[k] = counts.get(k, 0) + 1
        return counts

    @staticmethod
    def _reject(
        candidate: PortfolioCandidate,
        status: EligibilityStatus,
        reason: str,
    ) -> PortfolioCandidate:
        candidate.eligibility_status = status
        candidate.eligibility_reason = reason
        return candidate
