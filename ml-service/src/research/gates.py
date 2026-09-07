"""
Phase 3S — Automated research gates (spec §51).

Nine gates must all pass before an experiment can be recommended as a
CHALLENGER_CANDIDATE:

  Gate 1 — Data:        PIT-safe and reproducible.
  Gate 2 — Methodology: correct split and no leakage.
  Gate 3 — Baseline:    a meaningful baseline exists and is beaten.
  Gate 4 — OOS:         untouched OOS evaluated (not contaminated).
  Gate 5 — Costs:       net economics evaluated (survives costs).
  Gate 6 — Stability:   temporal / regime / cross-sectional stability.
  Gate 7 — Statistics:  uncertainty + multiple-testing accounted for.
  Gate 8 — Reproduction: result reproducible.
  Gate 9 — Evidence:    complete immutable evidence package.

The gate result NEVER promotes anything — it only decides whether the experiment
is ELIGIBLE to be recommended as a challenger candidate (subject to human review,
spec §41, §52).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ResearchGate(str, Enum):
    DATA         = "DATA"
    METHODOLOGY  = "METHODOLOGY"
    BASELINE     = "BASELINE"
    OOS          = "OOS"
    COSTS        = "COSTS"
    STABILITY    = "STABILITY"
    STATISTICS   = "STATISTICS"
    REPRODUCTION = "REPRODUCTION"
    EVIDENCE     = "EVIDENCE"


RESEARCH_GATE_ORDER: tuple[ResearchGate, ...] = (
    ResearchGate.DATA, ResearchGate.METHODOLOGY, ResearchGate.BASELINE,
    ResearchGate.OOS, ResearchGate.COSTS, ResearchGate.STABILITY,
    ResearchGate.STATISTICS, ResearchGate.REPRODUCTION, ResearchGate.EVIDENCE,
)


class GateResult(str, Enum):
    PASS                  = "PASS"
    FAIL                  = "FAIL"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"


@dataclass
class GateConditions:
    """
    Inputs to the research gates (spec §51). All default to the SAFE (failing)
    value so that missing evidence never passes a gate — fail-closed.
    """
    # Gate 1 — Data
    pit_safe:                bool = False
    reproducible_snapshot:   bool = False
    # Gate 2 — Methodology
    split_correct:           bool = False
    no_leakage:              bool = False
    # Gate 3 — Baseline
    baseline_defined:        bool = False
    beats_baseline:          bool = False
    # Gate 4 — OOS
    oos_evaluated:           bool = False
    oos_contaminated:        bool = True   # assume contaminated until proven clean
    # Gate 5 — Costs
    net_economics_evaluated: bool = False
    survives_costs:          bool = False
    # Gate 6 — Stability
    temporal_stable:         bool = False
    regime_stable:           bool = False
    cross_sectional_stable:  bool = False
    # Gate 7 — Statistics
    uncertainty_reported:    bool = False
    multiple_testing_adjusted: bool = False
    sufficient_sample:       bool = False
    # Gate 8 — Reproduction
    reproduced:              bool = False
    # Gate 9 — Evidence
    evidence_package_complete: bool = False
    evidence_immutable:      bool = False


@dataclass
class GateOutcome:
    gate:      ResearchGate
    result:    GateResult
    reasons:   list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.result == GateResult.PASS

    def to_dict(self) -> dict:
        return {"gate": self.gate.value, "result": self.result.value,
                "reasons": self.reasons}


@dataclass
class GateReport:
    outcomes:  list[GateOutcome]

    @property
    def all_pass(self) -> bool:
        return len(self.outcomes) == len(RESEARCH_GATE_ORDER) and all(
            o.passed for o in self.outcomes)

    @property
    def challenger_eligible(self) -> bool:
        """Only when ALL nine gates pass (spec §51). Never a promotion — eligibility
        to be RECOMMENDED, subject to human review (§41, §52)."""
        return self.all_pass

    def failed_gates(self) -> list[str]:
        return [o.gate.value for o in self.outcomes if not o.passed]

    def to_dict(self) -> dict:
        return {
            "outcomes":            [o.to_dict() for o in self.outcomes],
            "all_pass":            self.all_pass,
            "challenger_eligible": self.challenger_eligible,
            "failed_gates":        self.failed_gates(),
        }


def _gate(gate: ResearchGate, conditions: list[tuple[bool, str]]) -> GateOutcome:
    reasons = [msg for ok, msg in conditions if not ok]
    result = GateResult.PASS if not reasons else GateResult.FAIL
    return GateOutcome(gate=gate, result=result, reasons=reasons)


def evaluate_research_gates(c: GateConditions) -> GateReport:
    """
    Run the nine research gates fail-closed (spec §51). Returns a GateReport;
    `challenger_eligible` is True only if every gate passes.
    """
    outcomes = [
        _gate(ResearchGate.DATA, [
            (c.pit_safe, "not PIT-safe"),
            (c.reproducible_snapshot, "snapshot not reproducible"),
        ]),
        _gate(ResearchGate.METHODOLOGY, [
            (c.split_correct, "split incorrect"),
            (c.no_leakage, "leakage detected"),
        ]),
        _gate(ResearchGate.BASELINE, [
            (c.baseline_defined, "no baseline defined"),
            (c.beats_baseline, "does not beat baseline"),
        ]),
        _gate(ResearchGate.OOS, [
            (c.oos_evaluated, "OOS not evaluated"),
            (not c.oos_contaminated, "OOS contaminated"),
        ]),
        _gate(ResearchGate.COSTS, [
            (c.net_economics_evaluated, "net economics not evaluated"),
            (c.survives_costs, "does not survive costs"),
        ]),
        _gate(ResearchGate.STABILITY, [
            (c.temporal_stable, "temporally unstable"),
            (c.regime_stable, "regime-unstable"),
            (c.cross_sectional_stable, "cross-sectionally unstable"),
        ]),
        _gate(ResearchGate.STATISTICS, [
            (c.uncertainty_reported, "uncertainty not reported"),
            (c.multiple_testing_adjusted, "multiple testing not adjusted"),
            (c.sufficient_sample, "insufficient sample"),
        ]),
        _gate(ResearchGate.REPRODUCTION, [
            (c.reproduced, "not reproduced"),
        ]),
        _gate(ResearchGate.EVIDENCE, [
            (c.evidence_package_complete, "evidence package incomplete"),
            (c.evidence_immutable, "evidence not immutable"),
        ]),
    ]
    return GateReport(outcomes=outcomes)
