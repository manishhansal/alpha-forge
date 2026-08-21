"""
Failing tests for the IV Regime Classifier (PatchTST).

These tests are written BEFORE the implementation exists at
ml-service/src/iv_regime_classifier.py. They will fail with ImportError until
Task 11.2 (implementation) is complete.

This is the TDD red phase — all tests are expected to FAIL initially.

Validates: Requirements 9.1, 9.2, 9.3
"""

import pytest

# ---------------------------------------------------------------------------
# Import-under-test
# This import will raise ImportError until src/iv_regime_classifier.py is
# created. That is intentional — it confirms the TDD red phase.
# ---------------------------------------------------------------------------
from src.iv_regime_classifier import IVClassifier  # noqa: E402  (fails until implemented)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# PatchTST model shape per Requirement 9.1
N_FEATURES = 5    # atm_iv, pcr, oi_change, vix, spot_change
N_DAYS = 20       # 20 days of daily history

VALID_CLASSES = frozenset({"CRUSH", "STABLE", "SPIKE"})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_iv_input(n_days: int = N_DAYS, n_features: int = N_FEATURES) -> list[list[float]]:
    """
    Build a synthetic 5×20 input for the IV classifier.

    Shape: [n_days, n_features]
    Features per row: [atm_iv, pcr, oi_change, vix, spot_change]

    Values are realistic for NSE options daily data.
    """
    import random
    random.seed(99)
    rows = []
    for _ in range(n_days):
        atm_iv = random.uniform(10.0, 30.0)    # ATM IV in %
        pcr = random.uniform(0.5, 1.8)          # Put-Call Ratio
        oi_change = random.uniform(-0.15, 0.15) # OI change (fractional)
        vix = random.uniform(11.0, 35.0)        # India VIX level
        spot_change = random.uniform(-0.03, 0.03)  # spot % change
        rows.append([atm_iv, pcr, oi_change, vix, spot_change])
    return rows


# ---------------------------------------------------------------------------
# Test 1 — Model instantiates without error
# ---------------------------------------------------------------------------

class TestIVClassifierLoad:
    """Requirement 9.1: IV classifier can be instantiated without error."""

    def test_model_loads_without_error(self):
        """
        Constructing an IVClassifier must not raise any exception.
        The class must initialise cleanly even without trained weights.
        """
        classifier = IVClassifier()
        assert classifier is not None, "IVClassifier() returned None"

    def test_model_is_correct_type(self):
        """IVClassifier() returns an IVClassifier instance."""
        classifier = IVClassifier()
        assert isinstance(classifier, IVClassifier)


# ---------------------------------------------------------------------------
# Test 2 — Model accepts 5×20 input shape (5 features × 20 days)
# ---------------------------------------------------------------------------

class TestIVClassifierInputShape:
    """Requirement 9.1: classifier accepts a 5×20 input (5 features × 20 days)."""

    def test_predict_accepts_5x20_input(self):
        """
        predict() must accept a 20-row × 5-feature input without raising.

        Shape: [n_days=20, n_features=5]
        Features: atm_iv, pcr, oi_change, vix, spot_change
        """
        classifier = IVClassifier()
        data = make_iv_input(n_days=N_DAYS, n_features=N_FEATURES)
        assert len(data) == N_DAYS, f"Expected {N_DAYS} rows, got {len(data)}"
        assert len(data[0]) == N_FEATURES, f"Expected {N_FEATURES} features, got {len(data[0])}"
        # Should not raise
        result = classifier.predict(data)
        assert result is not None

    def test_predict_returns_a_value(self):
        """predict() must return a non-None result."""
        classifier = IVClassifier()
        data = make_iv_input()
        result = classifier.predict(data)
        assert result is not None, "predict() returned None for valid input"


# ---------------------------------------------------------------------------
# Test 3 — Output is one of CRUSH | STABLE | SPIKE
# ---------------------------------------------------------------------------

class TestIVClassifierOutput:
    """Requirement 9.2: output class must be one of CRUSH, STABLE, or SPIKE."""

    def test_output_is_string(self):
        """predict() must return a string (the class label)."""
        classifier = IVClassifier()
        data = make_iv_input()
        result = classifier.predict(data)
        assert isinstance(result, str), (
            f"predict() must return a string, got {type(result)}"
        )

    def test_output_is_valid_class(self):
        """Output must be exactly one of 'CRUSH', 'STABLE', or 'SPIKE'."""
        classifier = IVClassifier()
        data = make_iv_input()
        result = classifier.predict(data)
        assert result in VALID_CLASSES, (
            f"predict() returned '{result}', expected one of {VALID_CLASSES}"
        )

    @pytest.mark.parametrize("seed", [1, 7, 13, 21, 42])
    def test_output_always_valid_class_across_inputs(self, seed: int):
        """
        Output is always CRUSH | STABLE | SPIKE for diverse random inputs.

        **Validates: Requirements 9.1, 9.2**
        """
        import random
        random.seed(seed)
        data = make_iv_input()
        classifier = IVClassifier()
        result = classifier.predict(data)
        assert result in VALID_CLASSES, (
            f"[seed={seed}] predict() returned '{result}', "
            f"not in {VALID_CLASSES}"
        )


# ---------------------------------------------------------------------------
# Test 4 — Model exposes expected public interface
# ---------------------------------------------------------------------------

class TestIVClassifierInterface:
    """IVClassifier must expose the expected public interface."""

    def test_classifier_has_predict_method(self):
        """IVClassifier must have a predict() method."""
        classifier = IVClassifier()
        assert hasattr(classifier, "predict"), (
            "IVClassifier must expose a 'predict' method"
        )
        assert callable(classifier.predict), (
            "IVClassifier.predict must be callable"
        )

    def test_predict_accepts_list_of_lists(self):
        """predict() must accept a list[list[float]] input (no numpy required)."""
        classifier = IVClassifier()
        data: list[list[float]] = [
            [15.0, 1.2, 0.05, 18.0, 0.01] for _ in range(N_DAYS)
        ]
        result = classifier.predict(data)
        assert result in VALID_CLASSES, (
            f"predict() failed on list-of-lists input, got '{result}'"
        )
