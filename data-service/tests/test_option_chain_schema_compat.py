"""
Contract test: Python OptionChain schema ↔ TypeScript OptionChain type compatibility.

Asserts that the Python Pydantic models (OptionChain, OptionChainAnalytics, and their
nested types) expose exactly the same field names and compatible types as the canonical
TypeScript definitions in ``src/lib/market-data/types.ts``.

This is the structural guard referenced in Requirements 4.14.

Failing here means the Python response shape has drifted from the TypeScript consumer's
expectations — fix ``data-service/src/schemas.py`` to restore compatibility.
"""

from __future__ import annotations

import inspect
from typing import Any, Optional, get_args, get_origin, get_type_hints

import pytest

from src.schemas import (
    Greeks,
    OptionChain,
    OptionChainAnalytics,
    OptionChainRow,
    OptionContract,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _model_fields(model_cls: type) -> dict[str, Any]:
    """Return the Pydantic model_fields dict (Pydantic v2 API)."""
    return model_cls.model_fields  # type: ignore[attr-defined]


def _is_optional(annotation: Any) -> bool:
    """Return True when the annotation is ``Optional[X]`` (i.e. ``Union[X, None]``)."""
    origin = get_origin(annotation)
    # Optional[X] is Union[X, None]; get_origin returns typing.Union
    if origin is not None:
        args = get_args(annotation)
        return type(None) in args
    return False


def _inner_type(annotation: Any) -> Any:
    """Return the non-None inner type for Optional[X], else the annotation itself."""
    if _is_optional(annotation):
        return next(a for a in get_args(annotation) if a is not type(None))
    return annotation


# ---------------------------------------------------------------------------
# OptionChainAnalytics field assertions
# ---------------------------------------------------------------------------


class TestOptionChainAnalyticsFields:
    """The Python OptionChainAnalytics model must mirror the TypeScript type exactly."""

    # TypeScript:
    #   pcrOi, pcrVolume, maxCeOiStrike, maxPeOiStrike  — number | null
    #   totalCeOi, totalPeOi, totalCeOiChange, totalPeOiChange  — number (required)
    #   atmIv, maxPain  — number | null

    NULLABLE_FLOAT_FIELDS = {
        "pcrOi",
        "pcrVolume",
        "maxCeOiStrike",
        "maxPeOiStrike",
        "atmIv",
        "maxPain",
    }

    REQUIRED_INT_FIELDS = {
        "totalCeOi",
        "totalPeOi",
        "totalCeOiChange",
        "totalPeOiChange",
    }

    ALL_FIELDS = NULLABLE_FLOAT_FIELDS | REQUIRED_INT_FIELDS

    def test_all_10_typescript_fields_present(self) -> None:
        """All 10 TypeScript OptionChainAnalytics fields must be present."""
        fields = set(_model_fields(OptionChainAnalytics).keys())
        missing = self.ALL_FIELDS - fields
        assert not missing, (
            f"OptionChainAnalytics is missing TypeScript fields: {sorted(missing)}"
        )

    def test_nullable_float_fields_are_optional_float(self) -> None:
        """pcrOi, pcrVolume, maxCeOiStrike, maxPeOiStrike, atmIv, maxPain must be Optional[float]."""
        hints = get_type_hints(OptionChainAnalytics)
        for field_name in self.NULLABLE_FLOAT_FIELDS:
            annotation = hints[field_name]
            assert _is_optional(annotation), (
                f"OptionChainAnalytics.{field_name} should be Optional[...], got {annotation}"
            )
            inner = _inner_type(annotation)
            assert inner is float, (
                f"OptionChainAnalytics.{field_name} inner type should be float, got {inner}"
            )

    def test_required_int_fields_are_int(self) -> None:
        """totalCeOi, totalPeOi, totalCeOiChange, totalPeOiChange must be int."""
        hints = get_type_hints(OptionChainAnalytics)
        for field_name in self.REQUIRED_INT_FIELDS:
            annotation = hints[field_name]
            assert annotation is int, (
                f"OptionChainAnalytics.{field_name} should be int, got {annotation}"
            )

    def test_required_int_fields_have_no_default(self) -> None:
        """Required int fields must not have a default (they are always provided)."""
        fields = _model_fields(OptionChainAnalytics)
        for field_name in self.REQUIRED_INT_FIELDS:
            field = fields[field_name]
            # Pydantic v2: required field has PydanticUndefined as default
            from pydantic_core import PydanticUndefinedType
            assert isinstance(field.default, PydanticUndefinedType), (
                f"OptionChainAnalytics.{field_name} should be required (no default), "
                f"got default={field.default!r}"
            )


# ---------------------------------------------------------------------------
# OptionChain top-level field assertions
# ---------------------------------------------------------------------------


class TestOptionChainFields:
    """The Python OptionChain model must mirror the TypeScript OptionChain type exactly."""

    # TypeScript OptionChain fields:
    #   underlying: string        — required str
    #   spot: number | null       — Optional[float]
    #   expiry: string            — required str
    #   expiries: string[]        — required list[str]
    #   rows: OptionChainRow[]    — required list[OptionChainRow]
    #   analytics: OptionChainAnalytics  — required
    #   provider: ProviderId      — Literal["scrapling"] (str subtype)
    #   fetchedAt: string         — required str

    REQUIRED_STR_FIELDS = {"underlying", "expiry", "fetchedAt"}
    ALL_FIELDS = {
        "underlying",
        "spot",
        "expiry",
        "expiries",
        "rows",
        "analytics",
        "provider",
        "fetchedAt",
    }

    def test_all_8_typescript_fields_present(self) -> None:
        """All 8 TypeScript OptionChain fields must be present."""
        fields = set(_model_fields(OptionChain).keys())
        missing = self.ALL_FIELDS - fields
        assert not missing, (
            f"OptionChain is missing TypeScript fields: {sorted(missing)}"
        )

    def test_spot_is_optional_float(self) -> None:
        """spot: number | null → Optional[float]."""
        hints = get_type_hints(OptionChain)
        assert _is_optional(hints["spot"]), "OptionChain.spot should be Optional[float]"
        assert _inner_type(hints["spot"]) is float, "OptionChain.spot inner type should be float"

    def test_required_str_fields_are_str(self) -> None:
        """underlying, expiry, fetchedAt must be plain str."""
        hints = get_type_hints(OptionChain)
        for field_name in self.REQUIRED_STR_FIELDS:
            assert hints[field_name] is str, (
                f"OptionChain.{field_name} should be str, got {hints[field_name]}"
            )

    def test_analytics_field_type_is_option_chain_analytics(self) -> None:
        """analytics field must be typed as OptionChainAnalytics."""
        hints = get_type_hints(OptionChain)
        assert hints["analytics"] is OptionChainAnalytics, (
            f"OptionChain.analytics should be OptionChainAnalytics, got {hints['analytics']}"
        )

    def test_expiries_field_is_list(self) -> None:
        """expiries must be a list type."""
        hints = get_type_hints(OptionChain)
        origin = get_origin(hints["expiries"])
        assert origin is list, (
            f"OptionChain.expiries should be list[str], got {hints['expiries']}"
        )

    def test_rows_field_is_list(self) -> None:
        """rows must be a list type."""
        hints = get_type_hints(OptionChain)
        origin = get_origin(hints["rows"])
        assert origin is list, (
            f"OptionChain.rows should be list[OptionChainRow], got {hints['rows']}"
        )

    def test_provider_default_is_scrapling(self) -> None:
        """provider field must default to 'scrapling' to match Literal["scrapling"]."""
        fields = _model_fields(OptionChain)
        assert fields["provider"].default == "scrapling", (
            f"OptionChain.provider default should be 'scrapling', "
            f"got {fields['provider'].default!r}"
        )

    def test_no_extra_typescript_fields_missing(self) -> None:
        """No TypeScript field may be silently renamed or dropped."""
        fields = set(_model_fields(OptionChain).keys())
        extra = fields - self.ALL_FIELDS
        # Extra Python-only fields are allowed; what matters is coverage of TypeScript fields.
        missing = self.ALL_FIELDS - fields
        assert not missing


# ---------------------------------------------------------------------------
# Round-trip serialisation test
# ---------------------------------------------------------------------------


class TestOptionChainRoundTrip:
    """Create a complete OptionChain object and verify model_dump() produces the expected shape."""

    def _make_greeks(self) -> Greeks:
        return Greeks(iv=20.5, delta=0.5, gamma=0.01, theta=-2.5, vega=10.0)

    def _make_contract(self, option_type: str) -> OptionContract:
        return OptionContract(
            token=f"NIFTY25JUL2025{option_type}24000",
            tradingSymbol=f"NIFTY25JUL2025{option_type}24000",
            underlying="NIFTY",
            expiry="2025-07-25",
            strike=24000.0,
            optionType=option_type,
            ltp=150.0,
            bid=149.5,
            ask=150.5,
            oi=100_000,
            oiChange=5_000,
            volume=200_000,
            greeks=self._make_greeks(),
            fetchedAt="2025-07-10T09:15:00.000Z",
        )

    def _make_analytics(self) -> OptionChainAnalytics:
        return OptionChainAnalytics(
            pcrOi=0.85,
            pcrVolume=0.90,
            maxCeOiStrike=24500.0,
            maxPeOiStrike=23500.0,
            totalCeOi=5_000_000,
            totalPeOi=4_250_000,
            totalCeOiChange=100_000,
            totalPeOiChange=80_000,
            atmIv=14.5,
            maxPain=24000.0,
        )

    def _make_row(self) -> OptionChainRow:
        return OptionChainRow(
            strike=24000.0,
            ce=self._make_contract("CE"),
            pe=self._make_contract("PE"),
        )

    def _make_chain(self) -> OptionChain:
        return OptionChain(
            underlying="NIFTY",
            spot=24050.75,
            expiry="2025-07-25",
            expiries=["2025-07-25", "2025-08-28", "2025-09-25"],
            rows=[self._make_row()],
            analytics=self._make_analytics(),
            provider="scrapling",
            fetchedAt="2025-07-10T09:15:00.000Z",
        )

    def test_round_trip_produces_all_top_level_fields(self) -> None:
        """model_dump() must contain all 8 TypeScript OptionChain fields."""
        chain = self._make_chain()
        dumped = chain.model_dump()

        expected_keys = {
            "underlying", "spot", "expiry", "expiries",
            "rows", "analytics", "provider", "fetchedAt",
        }
        assert expected_keys <= set(dumped.keys()), (
            f"model_dump() missing keys: {expected_keys - set(dumped.keys())}"
        )

    def test_round_trip_analytics_contains_all_fields(self) -> None:
        """analytics dict in model_dump() must contain all 10 TypeScript fields."""
        chain = self._make_chain()
        analytics_dict = chain.model_dump()["analytics"]

        expected_keys = {
            "pcrOi", "pcrVolume", "maxCeOiStrike", "maxPeOiStrike",
            "totalCeOi", "totalPeOi", "totalCeOiChange", "totalPeOiChange",
            "atmIv", "maxPain",
        }
        assert expected_keys <= set(analytics_dict.keys()), (
            f"analytics dict missing keys: {expected_keys - set(analytics_dict.keys())}"
        )

    def test_round_trip_field_values_are_correct(self) -> None:
        """Scalar field values survive the round-trip unchanged."""
        chain = self._make_chain()
        dumped = chain.model_dump()

        assert dumped["underlying"] == "NIFTY"
        assert dumped["spot"] == 24050.75
        assert dumped["expiry"] == "2025-07-25"
        assert dumped["expiries"] == ["2025-07-25", "2025-08-28", "2025-09-25"]
        assert dumped["provider"] == "scrapling"
        assert dumped["fetchedAt"] == "2025-07-10T09:15:00.000Z"

    def test_round_trip_analytics_values_are_correct(self) -> None:
        """Analytics values survive the round-trip unchanged."""
        chain = self._make_chain()
        a = chain.model_dump()["analytics"]

        assert a["pcrOi"] == 0.85
        assert a["pcrVolume"] == 0.90
        assert a["maxCeOiStrike"] == 24500.0
        assert a["maxPeOiStrike"] == 23500.0
        assert a["totalCeOi"] == 5_000_000
        assert a["totalPeOi"] == 4_250_000
        assert a["totalCeOiChange"] == 100_000
        assert a["totalPeOiChange"] == 80_000
        assert a["atmIv"] == 14.5
        assert a["maxPain"] == 24000.0

    def test_round_trip_rows_structure(self) -> None:
        """rows list contains one row with strike, ce, and pe populated."""
        chain = self._make_chain()
        rows = chain.model_dump()["rows"]

        assert len(rows) == 1
        row = rows[0]
        assert row["strike"] == 24000.0
        assert row["ce"] is not None
        assert row["pe"] is not None
        assert row["ce"]["optionType"] == "CE"
        assert row["pe"]["optionType"] == "PE"

    def test_spot_can_be_null(self) -> None:
        """spot=None must round-trip to None in the dump (TypeScript: number | null)."""
        chain = self._make_chain()
        chain = chain.model_copy(update={"spot": None})
        assert chain.model_dump()["spot"] is None

    def test_nullable_analytics_fields_can_be_none(self) -> None:
        """Nullable analytics fields (pcrOi etc.) round-trip correctly when None."""
        analytics = OptionChainAnalytics(
            pcrOi=None,
            pcrVolume=None,
            maxCeOiStrike=None,
            maxPeOiStrike=None,
            totalCeOi=0,
            totalPeOi=0,
            totalCeOiChange=0,
            totalPeOiChange=0,
            atmIv=None,
            maxPain=None,
        )
        dumped = analytics.model_dump()
        for nullable_field in ("pcrOi", "pcrVolume", "maxCeOiStrike", "maxPeOiStrike", "atmIv", "maxPain"):
            assert dumped[nullable_field] is None, (
                f"analytics.{nullable_field} should be None when unset"
            )

    def test_model_validate_round_trip(self) -> None:
        """A dict produced by model_dump() can be re-parsed by model_validate()."""
        original = self._make_chain()
        dumped = original.model_dump()
        restored = OptionChain.model_validate(dumped)

        assert restored.underlying == original.underlying
        assert restored.expiry == original.expiry
        assert restored.provider == "scrapling"
        assert restored.analytics.pcrOi == original.analytics.pcrOi
        assert restored.analytics.totalCeOi == original.analytics.totalCeOi
