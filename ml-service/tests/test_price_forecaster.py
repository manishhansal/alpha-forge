"""
Failing tests for the TFT Price Regime Forecaster.

These tests are written BEFORE the implementation exists at
ml-service/src/price_forecaster.py. They will fail with ImportError until
Task 10.2 (implementation) is complete.

This is the TDD red phase — all tests are expected to FAIL initially.

Validates: Requirements 8.1, 8.2, 8.3
"""

import pytest

# ---------------------------------------------------------------------------
# Import-under-test
# This import will raise ImportError until src/price_forecaster.py is created.
# That is intentional — it confirms the TDD red phase.
# ---------------------------------------------------------------------------
from src.price_forecaster import PriceForecaster  # noqa: E402  (fails until implemented)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# TFT model hyperparameters as specified in requirements 8.2
INPUT_CHUNK_LENGTH = 60   # 60 × 5-min bars = 5 trading hours of history
NUM_FEATURES = 9          # OHLCV (5) + VPIN + ATM IV + PCR + OI build-up
VALID_REGIMES = frozenset({"bull", "bear", "flat"})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_multivariate_input(n_bars: int = 60, n_features: int = NUM_FEATURES) -> list[list[float]]:
    """
    Build a synthetic 60-bar multivariate OHLCV+features input.

    Shape: [n_bars, n_features]
    Features: [open, high, low, close, volume, vpin, atm_iv, pcr, oi_buildup]

    Values are realistic for NIFTY 5-min bars.
    """
    import random
    random.seed(42)
    bars = []
    price = 23000.0
    for _ in range(n_bars):
        open_ = price
        close = price + random.uniform(-50, 50)
        high = max(open_, close) + random.uniform(0, 20)
        low = min(open_, close) - random.uniform(0, 20)
        volume = random.uniform(50_000, 200_000)
        vpin = random.uniform(0.0, 1.0)
        atm_iv = random.uniform(10.0, 30.0)
        pcr = random.uniform(0.5, 1.5)
        oi_buildup = random.uniform(-0.1, 0.1)
        bars.append([open_, high, low, close, volume, vpin, atm_iv, pcr, oi_buildup])
        price = close
    return bars


# ---------------------------------------------------------------------------
# Test 1 — Model instantiates without error
# ---------------------------------------------------------------------------

class TestPriceForecasterLoad:
    """Requirement 8.2: model can be instantiated without error."""

    def test_model_loads_without_error(self):
        """
        Constructing a PriceForecaster must not raise any exception.
        The model may be untrained (no artifact file), but the class
        must initialise cleanly.
        """
        # Should not raise — even without trained weights
        forecaster = PriceForecaster()
        assert forecaster is not None, "PriceForecaster() returned None"

    def test_model_is_correct_type(self):
        """PriceForecaster() returns a PriceForecaster instance."""
        forecaster = PriceForecaster()
        assert isinstance(forecaster, PriceForecaster)


# ---------------------------------------------------------------------------
# Test 2 — Model accepts 60-bar multivariate input and returns correct shape
# ---------------------------------------------------------------------------

class TestPriceForecasterInputOutput:
    """
    Requirements 8.1, 8.3: model accepts 60-bar multivariate input and returns
    {regime, probability, q10, q90}.
    """

    def test_predict_returns_dict(self):
        """predict() must return a dict."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        assert isinstance(result, dict), (
            f"predict() must return a dict, got {type(result)}"
        )

    def test_predict_returns_required_keys(self):
        """Result must contain all four required keys: regime, probability, q10, q90."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        required_keys = {"regime", "probability", "q10", "q90"}
        missing = required_keys - result.keys()
        assert not missing, f"predict() result missing keys: {missing}"

    def test_predict_accepts_60_bar_input(self):
        """predict() must accept exactly 60 bars without raising."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input(n_bars=60)
        # Should not raise
        result = forecaster.predict(bars)
        assert result is not None

    def test_predict_accepts_9_feature_input(self):
        """
        Each bar must have 9 features: OHLCV + VPIN + ATM IV + PCR + OI buildup.
        (Per Requirement 8.1: 'including OHLCV, VPIN, ATM IV, PCR, and OI build-up')
        """
        forecaster = PriceForecaster()
        bars = make_multivariate_input(n_bars=60, n_features=NUM_FEATURES)
        assert len(bars) == 60
        assert all(len(bar) == NUM_FEATURES for bar in bars), (
            f"Expected {NUM_FEATURES} features per bar, got {len(bars[0])}"
        )
        # predict() should not raise
        result = forecaster.predict(bars)
        assert result is not None


# ---------------------------------------------------------------------------
# Test 3 — probability ∈ [0, 1]
# ---------------------------------------------------------------------------

class TestPriceForecasterProbability:
    """Requirement 8.3: probability field must be in [0, 1]."""

    def test_probability_in_unit_interval(self):
        """probability must be a float in the closed interval [0, 1]."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        prob = result["probability"]
        assert isinstance(prob, (int, float)), (
            f"probability must be numeric, got {type(prob)}"
        )
        assert 0.0 <= float(prob) <= 1.0, (
            f"probability {prob} is not in [0, 1]"
        )

    @pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
    def test_probability_always_in_unit_interval(self, seed: int):
        """
        probability ∈ [0, 1] for multiple different random inputs.

        **Validates: Requirements 8.3**
        """
        import random
        random.seed(seed)
        bars = make_multivariate_input()
        forecaster = PriceForecaster()
        result = forecaster.predict(bars)
        prob = float(result["probability"])
        assert 0.0 <= prob <= 1.0, (
            f"[seed={seed}] probability {prob} not in [0, 1]"
        )


# ---------------------------------------------------------------------------
# Test 4 — regime is one of "bull" | "bear" | "flat"
# ---------------------------------------------------------------------------

class TestPriceForecasterRegime:
    """Requirement 8.3: regime must be one of 'bull', 'bear', or 'flat'."""

    def test_regime_is_valid_string(self):
        """regime must be a non-empty string."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        assert isinstance(result["regime"], str), (
            f"regime must be a string, got {type(result['regime'])}"
        )
        assert result["regime"], "regime must be non-empty"

    def test_regime_is_one_of_valid_values(self):
        """regime must be exactly one of 'bull', 'bear', or 'flat'."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        assert result["regime"] in VALID_REGIMES, (
            f"regime '{result['regime']}' is not one of {VALID_REGIMES}"
        )

    @pytest.mark.parametrize("seed", [10, 20, 30, 40, 50])
    def test_regime_always_valid_across_inputs(self, seed: int):
        """
        regime is always 'bull' | 'bear' | 'flat' for diverse inputs.

        **Validates: Requirements 8.1, 8.3**
        """
        import random
        random.seed(seed)
        bars = make_multivariate_input()
        forecaster = PriceForecaster()
        result = forecaster.predict(bars)
        assert result["regime"] in VALID_REGIMES, (
            f"[seed={seed}] regime '{result['regime']}' not in {VALID_REGIMES}"
        )


# ---------------------------------------------------------------------------
# Test 5 — q10 and q90 are numeric (quantile bounds)
# ---------------------------------------------------------------------------

class TestPriceForecasterQuantiles:
    """Requirement 8.3: q10 and q90 must be numeric floats."""

    def test_q10_is_numeric(self):
        """q10 must be a numeric value (10th percentile expected move %)."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        assert isinstance(result["q10"], (int, float)), (
            f"q10 must be numeric, got {type(result['q10'])}"
        )

    def test_q90_is_numeric(self):
        """q90 must be a numeric value (90th percentile expected move %)."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        assert isinstance(result["q90"], (int, float)), (
            f"q90 must be numeric, got {type(result['q90'])}"
        )

    def test_q90_greater_than_or_equal_q10(self):
        """q90 must be ≥ q10 (quantile ordering constraint)."""
        forecaster = PriceForecaster()
        bars = make_multivariate_input()
        result = forecaster.predict(bars)
        q10 = float(result["q10"])
        q90 = float(result["q90"])
        assert q90 >= q10, (
            f"q90 ({q90}) must be ≥ q10 ({q10})"
        )
