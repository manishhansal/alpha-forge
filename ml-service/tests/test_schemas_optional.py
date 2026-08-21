"""
Bug 1 — Exploration tests for RegimePredictionRequest optional fields.

These tests run BEFORE any fix is applied. The Hypothesis exploration test
is EXPECTED TO FAIL on unfixed code because the ten required fields are bare
`float` (no Optional, no default), so Pydantic raises a ValidationError when
any field is absent.

The preservation test (`test_complete_body_accepted`) PASSES on both unfixed
and fixed code — it documents that a complete body always works.

Bug Condition (isBugCondition_1):
  EXISTS field IN REQUIRED_FIELDS WHERE field NOT IN requestBody

Expected counterexample: body omitting `advance_decline_ratio` →
  ValidationError: 1 validation error for RegimePredictionRequest
    advance_decline_ratio — Field required

Validates: Requirements 1.1, 1.4
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st
from pydantic import ValidationError

from src.schemas import RegimePredictionRequest


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# The ten currently-required (bare float, no Optional) fields in
# RegimePredictionRequest.  These are the fields the TypeScript caller may
# omit, triggering a Pydantic 422 on the unfixed schema.
REQUIRED_FIELDS = [
    "nifty_change_pct",
    "banknifty_change_pct",
    "india_vix",
    "nifty_atr_pct",
    "nifty_adx",
    "advance_decline_ratio",
    "market_breadth",
    "sector_strength",
    "volume_ratio",
    "gap_pct",
]

# A complete, valid body with all ten required fields present.
COMPLETE_BODY: dict[str, float] = {
    "nifty_change_pct": 0.5,
    "banknifty_change_pct": 0.3,
    "india_vix": 14.2,
    "nifty_atr_pct": 0.8,
    "nifty_adx": 25.0,
    "advance_decline_ratio": 0.6,
    "market_breadth": 55.0,
    "sector_strength": 0.4,
    "volume_ratio": 1.1,
    "gap_pct": 0.1,
}


# ---------------------------------------------------------------------------
# Strategy: generate partial bodies by dropping ≥1 required fields
# ---------------------------------------------------------------------------

# Strategy that picks a non-empty subset of fields to DROP from the body.
# Hypothesis will explore all possible drop patterns across many examples.
fields_to_drop_st = st.lists(
    st.sampled_from(REQUIRED_FIELDS),
    min_size=1,
    max_size=len(REQUIRED_FIELDS),
    unique=True,
)


# ---------------------------------------------------------------------------
# Preservation baseline — PASSES on unfixed and fixed code
# ---------------------------------------------------------------------------


def test_complete_body_accepted():
    """
    A body with all ten required fields must always be accepted by
    RegimePredictionRequest without raising a ValidationError.

    This is the preservation baseline — it must pass on both unfixed and
    fixed code.
    """
    req = RegimePredictionRequest(**COMPLETE_BODY)
    assert req.nifty_change_pct == 0.5
    assert req.india_vix == 14.2
    assert req.advance_decline_ratio == 0.6


def test_zero_value_fields_not_treated_as_missing():
    """
    A body where advance_decline_ratio == 0.0 must be accepted.
    Zero is a valid value, not a sentinel for 'missing'.
    """
    body = {**COMPLETE_BODY, "advance_decline_ratio": 0.0}
    req = RegimePredictionRequest(**body)
    assert req.advance_decline_ratio == 0.0


# ---------------------------------------------------------------------------
# Bug exploration — EXPECTED TO FAIL on unfixed code (Hypothesis)
# ---------------------------------------------------------------------------


@given(fields_to_drop=fields_to_drop_st)
@settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
def test_partial_body_accepted_no_validation_error(fields_to_drop: list[str]):
    """
    Property 1 (Bug Condition): For any subset of the ten required fields
    dropped from an otherwise-valid body, RegimePredictionRequest MUST NOT
    raise a ValidationError.

    On UNFIXED code this test FAILS because the fields are bare `float`
    with no Optional/default. The failure IS the expected counterexample:

      Counterexample: body omitting {'advance_decline_ratio'}
        → ValidationError: 1 validation error for RegimePredictionRequest
            advance_decline_ratio — Field required

    On FIXED code (all ten fields made Optional[float] = None) this test
    PASSES.

    isBugCondition_1: EXISTS field IN REQUIRED_FIELDS WHERE field NOT IN requestBody

    **Validates: Requirements 1.1**
    """
    partial_body = {k: v for k, v in COMPLETE_BODY.items() if k not in fields_to_drop}

    # Assert no ValidationError is raised for the partial body.
    # On unfixed code, Pydantic raises ValidationError — that IS the bug.
    try:
        req = RegimePredictionRequest(**partial_body)
        # If instantiation succeeds, verify the present fields are correct.
        for field, value in partial_body.items():
            assert getattr(req, field) == value, (
                f"Field {field!r} value mismatch: expected {value}, "
                f"got {getattr(req, field)}"
            )
    except ValidationError as exc:
        # On unfixed code: record the counterexample and re-raise so Hypothesis
        # can shrink and report it. This is the expected failure mode.
        missing = [e["loc"][-1] for e in exc.errors() if e.get("type") == "missing"]
        pytest.fail(
            f"Bug 1 confirmed: RegimePredictionRequest raised ValidationError for "
            f"a partial body missing {missing}.\n"
            f"Dropped fields: {fields_to_drop}\n"
            f"Pydantic error: {exc}"
        )


# ---------------------------------------------------------------------------
# Concrete counterexample — documented failing case
# ---------------------------------------------------------------------------


def test_body_missing_advance_decline_ratio_concrete_counterexample():
    """
    Concrete counterexample for Bug 1:

    A body missing only `advance_decline_ratio` raises a ValidationError on
    unfixed code. This is the canonical failing example documented in the spec.

    On FIXED code this test PASSES (no ValidationError raised).

    Counterexample: body omitting advance_decline_ratio →
      ValidationError: 1 validation error for RegimePredictionRequest
        advance_decline_ratio — Field required
    """
    body_missing_adr = {k: v for k, v in COMPLETE_BODY.items() if k != "advance_decline_ratio"}

    try:
        req = RegimePredictionRequest(**body_missing_adr)
        # On fixed code: should succeed; advance_decline_ratio defaults to None.
        assert req.advance_decline_ratio is None, (
            "After fix, advance_decline_ratio should default to None when omitted"
        )
    except ValidationError as exc:
        # On unfixed code: this confirms the bug exists.
        pytest.fail(
            f"Bug 1 confirmed (concrete counterexample): "
            f"Body missing 'advance_decline_ratio' raised ValidationError.\n"
            f"Error: {exc}"
        )
