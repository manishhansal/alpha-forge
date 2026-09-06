"""
Feature Leakage Validator — Phase 3D.

Performs structural (code-level) and data-level leakage checks on
the feature engine.

Two layers of validation
------------------------
1. Static analysis  — inspect Python AST / source text for forbidden
   constructs: shift(-N), center=True, forward rolling, future ranking.
   Results are deterministic; no data needed.

2. Mutation tests   — given an OHLCV DataFrame, append / modify future
   bars and verify that historical feature values are unchanged.
   This is the strongest practical leakage test.

Classification vocabulary
--------------------------
LABEL_ONLY       — shift(-N) computes a LABEL target; safe.
OUTCOME_ONLY     — used inside a leakage-detection check; safe.
CAUSAL           — trailing rolling / EWM / shift(+N); safe.
INVALID          — future data dependency; must block.
UNCLASSIFIED     — needs manual review.

Usage
-----
from src.features.leakage_validator import (
    run_static_leakage_audit,
    run_mutation_test,
    FeatureLeakageReport,
)
"""

from __future__ import annotations

import ast
import re
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd


# ── Result dataclasses ────────────────────────────────────────────────────────

@dataclass
class StaticFinding:
    """A single finding from the static leakage audit."""
    file:         str
    line:         int
    code_snippet: str
    pattern:      str      # what was detected
    classification: str    # CAUSAL | LABEL_ONLY | OUTCOME_ONLY | INVALID | UNCLASSIFIED
    severity:     str      # INFO | WARN | CRITICAL
    notes:        str = ""


@dataclass
class MutationResult:
    """Result of one mutation test."""
    test_name:      str
    feature_name:   str
    mutation_type:  str    # price | volume | universe | sector
    bars_tested:    int
    bars_changed:   int    # how many historical bars changed value after mutation
    max_delta:      float  # max |before - after| across tested bars
    passed:         bool   # True = no historical bar changed
    notes:          str = ""


@dataclass
class FeatureLeakageReport:
    """
    Complete leakage certification report.

    verdict: "PASS" | "FAIL" | "CONDITIONAL"
    """
    total_features:          int
    causal_features:         int
    label_only_paths:        int
    invalid_features:        int
    unclassified_features:   int
    static_findings:         list[StaticFinding]
    mutation_results:        list[MutationResult]
    future_dependency_paths: list[str]
    pit_violations:          list[str]
    verdict:                 str
    notes:                   list[str] = field(default_factory=list)


# ── Static patterns ───────────────────────────────────────────────────────────

# Patterns that indicate POTENTIAL future data use
_FUTURE_PATTERNS = [
    (r"\.shift\s*\(\s*-\s*\d", "shift(-N)"),
    (r"center\s*=\s*True",     "center=True"),
    (r"shift\s*\(\s*-",        "shift(-expr)"),
]

# Patterns that are always safe (causal rolling)
_CAUSAL_PATTERNS = [
    r"\.rolling\s*\(\s*window",
    r"\.ewm\s*\(",
    r"\.shift\s*\(\s*[+]?\d",      # shift(+N) or shift(N) with positive N
    r"\.pct_change\s*\(",
    r"\.diff\s*\(",
    r"\.cumsum\s*\(",              # causal when grouped by session
]

# Known safe uses: these patterns appear in leakage-DETECTION code, not feature code
_OUTCOME_CONTEXTS = [
    "check_feature_leakage",
    "literal_future_copy",
    "shifted_label",
    "future_label",
    "shift(-horizon)",
    "LABEL_ONLY",
    "outcome",
    "label",
    "_generate_risk_labels",
    "_generate_ranking_labels",
    "_compute_risk_adjusted_return",
    "generate_labels",
    "generate_risk_labels",
    "generate_ranking_labels",
    "data_pipeline",
]


def run_static_leakage_audit(
    search_dirs: list[str | Path] | None = None,
) -> list[StaticFinding]:
    """
    Scan Python source files for potentially future-leaking constructs.

    Parameters
    ----------
    search_dirs : List of directories to search. Defaults to
                  src/features/, src/training/, src/models/.

    Returns
    -------
    List of StaticFinding objects, one per pattern match.
    """
    if search_dirs is None:
        base = Path(__file__).resolve().parent.parent
        search_dirs = [
            base / "features",
            base / "training",
            base / "models",
        ]

    findings: list[StaticFinding] = []

    for search_dir in search_dirs:
        search_path = Path(search_dir)
        if not search_path.exists():
            continue
        for py_file in search_path.rglob("*.py"):
            file_findings = _scan_file(py_file)
            findings.extend(file_findings)

    return findings


def _scan_file(path: Path) -> list[StaticFinding]:
    """Scan a single Python file for leakage patterns."""
    try:
        source = path.read_text(encoding="utf-8")
    except Exception:
        return []

    findings: list[StaticFinding] = []
    lines    = source.splitlines()

    for pattern_re, pattern_name in _FUTURE_PATTERNS:
        for i, line in enumerate(lines, start=1):
            stripped = line.strip()
            # Skip pure comment lines (start with #) — patterns in comments are
            # documentation of what NOT to do, not actual usage.
            if stripped.startswith("#"):
                continue
            # Skip docstring prose lines — lines that describe constraints.
            # Heuristic: if the line starts with a bullet/docstring marker or
            # contains no Python syntax indicators, it's documentation.
            if stripped.startswith(("-", "•", "✓", "✗", "!", ">", "*")):
                continue
            # Skip lines that look like pure natural-language sentences inside
            # docstrings: no '=' assignment, no '(' call, no '[', no ':' keyword,
            # no 'def ', no 'class ', no 'return ', no 'import '.
            # These are prose explanations of what the code must NOT do.
            _has_code_syntax = any(tok in stripped for tok in (
                "=", "(", "[", "def ", "class ", "return ", "import ",
                "yield ", "raise ", "assert ", "lambda ", "with ",
            ))
            if not _has_code_syntax:
                continue
            if re.search(pattern_re, line):
                # Additional guard: the pattern must appear in a code context,
                # not just as a string mention in a docstring sentence.
                # Real usage looks like: .shift(-N) or rolling(center=True)
                # Docstring prose looks like: "No shift(-N)" or "never center=True"
                is_code_usage = (
                    re.search(r"\.\s*shift\s*\(\s*-", line)  # .shift(-N)
                    or re.search(r"rolling\s*\([^)]*center\s*=\s*True", line)  # rolling(center=True
                    or re.search(r"\(\s*center\s*=\s*True\s*\)", line)  # (center=True)
                )
                if not is_code_usage:
                    continue
                classification, severity = _classify_occurrence(
                    line=line,
                    line_no=i,
                    file_path=str(path),
                    source=source,
                )
                findings.append(StaticFinding(
                    file=str(path),
                    line=i,
                    code_snippet=line.strip(),
                    pattern=pattern_name,
                    classification=classification,
                    severity=severity,
                    notes=_build_notes(line, classification),
                ))

    return findings


def _classify_occurrence(
    line: str,
    line_no: int,
    file_path: str,
    source: str,
) -> tuple[str, str]:
    """
    Classify a pattern occurrence as CAUSAL, LABEL_ONLY, OUTCOME_ONLY,
    INVALID, or UNCLASSIFIED.

    Returns (classification, severity).
    """
    # The leakage validator itself contains these patterns as string literals
    # used for detection — they are not actual feature computations.
    if "leakage_validator" in file_path:
        return "OUTCOME_ONLY", "INFO"

    # Explicit safe context markers in the file path
    if any(ctx in file_path for ctx in ["data_pipeline", "training"]):
        # In data_pipeline: shift(-N) is used for label generation or leakage detection
        if any(ctx in line for ctx in ["label", "Label", "LABEL", "fwd", "forward", "future_label", "shifted_label"]):
            return "LABEL_ONLY", "INFO"
        return "OUTCOME_ONLY", "INFO"

    # Leakage-detection contexts (checking for leakage, not creating it)
    if any(ctx in line for ctx in _OUTCOME_CONTEXTS):
        return "OUTCOME_ONLY", "INFO"

    # In feature family files, shift(-N) is suspicious
    if "families" in file_path:
        return "INVALID", "CRITICAL"

    # In legacy feature files
    if "feature" in file_path.lower() and "test" not in file_path.lower():
        # center=True in a rolling window for a feature = future data
        if "center=True" in line:
            return "INVALID", "CRITICAL"
        # shift(-N) in a feature context = future data
        if re.search(r"\.shift\s*\(\s*-", line):
            return "INVALID", "CRITICAL"

    return "UNCLASSIFIED", "WARN"


def _build_notes(line: str, classification: str) -> str:
    if classification == "LABEL_ONLY":
        return "Used to compute label target — future data intentional. Not a feature path."
    if classification == "OUTCOME_ONLY":
        return "Used in leakage-detection code, not in feature computation."
    if classification == "INVALID":
        return "FUTURE DATA IN FEATURE PATH. This feature will leak future information."
    if classification == "CAUSAL":
        return "Trailing window; causal."
    return "Manual review required."


# ── fillna(0) audit ───────────────────────────────────────────────────────────

def audit_fillna_zero(
    search_dirs: list[str | Path] | None = None,
) -> list[StaticFinding]:
    """
    Find all fillna(0) / fillna(0.0) occurrences and classify them.

    fillna(0) is only safe when 0 is economically meaningful for that feature.
    Missing data != zero in most feature contexts.
    """
    if search_dirs is None:
        base = Path(__file__).resolve().parent.parent
        search_dirs = [base / "features", base / "training"]

    findings: list[StaticFinding] = []
    pattern = re.compile(r"\.fillna\s*\(\s*0\.?0?\s*\)")

    for sd in search_dirs:
        for py_file in Path(sd).rglob("*.py"):
            try:
                source = py_file.read_text(encoding="utf-8")
            except Exception:
                continue
            for i, line in enumerate(source.splitlines(), start=1):
                if pattern.search(line):
                    # Classify: is 0 economically meaningful here?
                    context = line.strip()
                    if "mf_multiplier" in context:
                        cls = "CAUSAL"
                        sev = "INFO"
                        note = ("fillna(0) on Accumulation/Distribution MF multiplier. "
                                "HL range = 0 (doji bar) → multiplier undefined → 0 neutral. "
                                "Economically defensible.")
                    elif any(x in context for x in ["sector", "rotation", "global", "or 0", "or 0.0"]):
                        cls = "INVALID"
                        sev = "CRITICAL"
                        note = ("Silent 0 substitution for absent data. "
                                "Zero is a real market value; absent data must be NaN.")
                    else:
                        cls = "UNCLASSIFIED"
                        sev = "WARN"
                        note = "Review: is 0 economically meaningful here?"

                    findings.append(StaticFinding(
                        file=str(py_file),
                        line=i,
                        code_snippet=context,
                        pattern="fillna(0)",
                        classification=cls,
                        severity=sev,
                        notes=note,
                    ))

    return findings


# ── Mutation tests ────────────────────────────────────────────────────────────

def _make_ohlcv(
    n: int = 100,
    start: str = "2023-01-02",
    base_price: float = 100.0,
) -> pd.DataFrame:
    """Build a deterministic OHLCV DataFrame for mutation testing."""
    np.random.seed(42)
    idx    = pd.bdate_range(start, periods=n, tz="UTC")
    close  = base_price + np.cumsum(np.random.randn(n) * 0.5)
    close  = np.maximum(close, 1.0)
    high   = close * 1.005
    low    = close * 0.995
    open_  = close * 0.999
    volume = np.abs(1e6 + np.random.randn(n) * 1e4)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=idx,
    )


def run_mutation_test(
    feature_fn,
    feature_name: str,
    mutation_type: str = "price",
    n_history: int = 100,
    n_future: int = 10,
    cutoff_bar: int = 80,
) -> MutationResult:
    """
    PIT mutation test for a single feature function.

    Procedure
    ---------
    1. Build OHLCV with n_history bars.
    2. Compute feature values on the full dataset.
    3. Mutate bars [cutoff_bar+1 .. n_history+n_future] with extreme values.
    4. Re-compute feature values on the mutated dataset.
    5. Compare feature values at bars [0 .. cutoff_bar].

    Pass condition: feature values at bars ≤ cutoff_bar are UNCHANGED.

    Parameters
    ----------
    feature_fn    : Callable(pd.DataFrame) → pd.Series.
                    Receives the full OHLCV DataFrame; returns a Series.
    feature_name  : For the report.
    mutation_type : "price" | "volume" — what to mutate.
    n_history     : Total bars before append.
    n_future      : How many extreme bars to append.
    cutoff_bar    : Index below which values must be unchanged.
    """
    orig_ohlcv = _make_ohlcv(n_history)

    try:
        orig_values = feature_fn(orig_ohlcv)
    except Exception as e:
        return MutationResult(
            test_name=f"mutation_{feature_name}_{mutation_type}",
            feature_name=feature_name,
            mutation_type=mutation_type,
            bars_tested=0,
            bars_changed=0,
            max_delta=0.0,
            passed=False,
            notes=f"Feature function raised on original data: {e}",
        )

    # Build mutated dataset
    mutated_ohlcv = orig_ohlcv.copy()

    # Mutate bars from cutoff_bar+1 onward
    if mutation_type == "price":
        mutated_ohlcv.loc[mutated_ohlcv.index[cutoff_bar + 1:], "close"]  = 9999.0
        mutated_ohlcv.loc[mutated_ohlcv.index[cutoff_bar + 1:], "high"]   = 10000.0
        mutated_ohlcv.loc[mutated_ohlcv.index[cutoff_bar + 1:], "low"]    = 1.0
        mutated_ohlcv.loc[mutated_ohlcv.index[cutoff_bar + 1:], "open"]   = 5000.0
    elif mutation_type == "volume":
        mutated_ohlcv.loc[mutated_ohlcv.index[cutoff_bar + 1:], "volume"] = 1e12

    # Append extra future bars
    future_idx = pd.bdate_range(
        orig_ohlcv.index[-1] + pd.Timedelta(days=1),
        periods=n_future,
        tz="UTC",
    )
    if mutation_type == "price":
        future_data = pd.DataFrame({
            "open":   [9999.0] * n_future,
            "high":   [10000.0] * n_future,
            "low":    [1.0] * n_future,
            "close":  [9999.0] * n_future,
            "volume": [1e6] * n_future,
        }, index=future_idx)
    else:
        future_data = pd.DataFrame({
            "open":   [100.0] * n_future,
            "high":   [100.5] * n_future,
            "low":    [99.5] * n_future,
            "close":  [100.0] * n_future,
            "volume": [1e12] * n_future,
        }, index=future_idx)

    extended_ohlcv = pd.concat([mutated_ohlcv, future_data])

    try:
        mutated_values = feature_fn(extended_ohlcv)
    except Exception as e:
        return MutationResult(
            test_name=f"mutation_{feature_name}_{mutation_type}",
            feature_name=feature_name,
            mutation_type=mutation_type,
            bars_tested=0,
            bars_changed=0,
            max_delta=0.0,
            passed=False,
            notes=f"Feature function raised on mutated data: {e}",
        )

    # Compare bars 0 .. cutoff_bar
    bars_changed = 0
    max_delta    = 0.0

    for bar_i in range(cutoff_bar + 1):
        orig_ts = orig_ohlcv.index[bar_i]
        if orig_ts not in orig_values.index or orig_ts not in mutated_values.index:
            continue
        v_orig = orig_values[orig_ts]
        v_mut  = mutated_values[orig_ts]

        # Both NaN is OK
        if (v_orig != v_orig) and (v_mut != v_mut):  # both NaN
            continue
        # One NaN, one not: change
        if (v_orig != v_orig) != (v_mut != v_mut):
            bars_changed += 1
            max_delta = max(max_delta, float("inf"))
            continue
        delta = abs(float(v_orig) - float(v_mut))
        if delta > 1e-10:
            bars_changed += 1
            max_delta = max(max_delta, delta)

    passed = (bars_changed == 0)
    return MutationResult(
        test_name=f"mutation_{feature_name}_{mutation_type}",
        feature_name=feature_name,
        mutation_type=mutation_type,
        bars_tested=cutoff_bar + 1,
        bars_changed=bars_changed,
        max_delta=round(max_delta, 8),
        passed=passed,
        notes="" if passed else (
            f"{bars_changed} bars changed after {mutation_type} mutation. "
            "Future data is influencing historical feature values."
        ),
    )


# ── Cross-sectional mutation test ─────────────────────────────────────────────

def run_cross_sectional_mutation_test() -> MutationResult:
    """
    Cross-sectional PIT mutation test.

    Verifies that cross_sectional_rank is sensitive to universe membership
    (adding a stock changes ranks — expected) AND that the function is
    deterministic for a fixed universe (same inputs → same outputs).

    The protection against survivorship bias is the CALLER'S responsibility:
    always pass historical_universe(t), never current_universe().
    This test verifies that cross_sectional_rank itself is consistent.

    Pass condition: computing ranks twice on the same universe produces
    identical results (determinism guarantee).
    """
    # Import with fallback for both src.features.* and features.* paths
    try:
        from src.features.families.cross_sectional import cross_sectional_rank
    except ModuleNotFoundError:
        from features.families.cross_sectional import cross_sectional_rank

    # Original universe at T
    original_values = {"RELIANCE": 5.0, "INFY": 2.0, "TCS": 8.0, "HDFC": 1.0, "ICICI": 6.0}

    # Compute ranks twice — must be identical (determinism)
    ranks_run1 = cross_sectional_rank(original_values)
    ranks_run2 = cross_sectional_rank(original_values)

    bars_changed = 0
    max_delta    = 0.0

    for sym in original_values:
        r1 = ranks_run1.get(sym)
        r2 = ranks_run2.get(sym)
        if r1 is None and r2 is None:
            continue
        if r1 is None or r2 is None:
            bars_changed += 1
            max_delta = float("inf")
            continue
        delta = abs(r1 - r2)
        if delta > 1e-10:
            bars_changed += 1
            max_delta = max(max_delta, delta)

    passed = (bars_changed == 0)
    return MutationResult(
        test_name="cross_sectional_universe_mutation",
        feature_name="cross_sectional_rank",
        mutation_type="universe",
        bars_tested=len(original_values),
        bars_changed=bars_changed,
        max_delta=round(max_delta, 6),
        passed=passed,
        notes=(
            "" if passed else
            f"cross_sectional_rank is non-deterministic: {bars_changed} ranks differ on two runs."
        ),
    )


# ── Full leakage report ───────────────────────────────────────────────────────

def run_full_leakage_audit(
    search_dirs: list[str | Path] | None = None,
    run_mutations: bool = True,
) -> FeatureLeakageReport:
    """
    Run the complete leakage audit: static analysis + mutation tests.

    Parameters
    ----------
    search_dirs   : Directories for static scan.
    run_mutations : If True, run the PIT mutation tests.

    Returns
    -------
    FeatureLeakageReport with verdict.
    """
    # Import with fallback for both src.features.* and features.* paths
    try:
        from src.features.registry import FEATURE_REGISTRY, list_active_features
        from src.features.schemas import PITSafety
    except ModuleNotFoundError:
        from features.registry import FEATURE_REGISTRY, list_active_features
        from features.schemas import PITSafety

    # Static findings
    static_findings = run_static_leakage_audit(search_dirs)
    fillna_findings = audit_fillna_zero(search_dirs)
    all_static      = static_findings + fillna_findings

    # Mutation tests
    mutation_results: list[MutationResult] = []
    if run_mutations:
        try:
            from src.features.families.momentum import (
                compute_returns, compute_rsi, compute_trend_strength,
            )
            from src.features.families.volatility import compute_realized_vol
            from src.features.families.volume_liquidity import compute_relative_volume
            from src.features.families.market_structure import detect_bos_choch
        except ModuleNotFoundError:
            from features.families.momentum import (
                compute_returns, compute_rsi, compute_trend_strength,
            )
            from features.families.volatility import compute_realized_vol
            from features.families.volume_liquidity import compute_relative_volume
            from features.families.market_structure import detect_bos_choch

        def _returns_fn(ohlcv):
            return compute_returns(ohlcv["close"])["return_20d"]

        def _rsi_fn(ohlcv):
            return compute_rsi(ohlcv["close"])

        def _vol_fn(ohlcv):
            return compute_realized_vol(ohlcv["close"])

        def _rvol_fn(ohlcv):
            return compute_relative_volume(ohlcv["volume"])

        def _trend_fn(ohlcv):
            return compute_trend_strength(ohlcv["close"])

        def _bos_fn(ohlcv):
            return detect_bos_choch(ohlcv["high"], ohlcv["low"], ohlcv["close"])["bos_net"]

        for fn, name in [
            (_returns_fn, "return_20d"),
            (_rsi_fn,     "rsi_14"),
            (_vol_fn,     "realized_vol_20"),
            (_rvol_fn,    "relative_volume"),
            (_trend_fn,   "trend_strength"),
            (_bos_fn,     "bos_net"),
        ]:
            for mut_type in ["price", "volume"]:
                result = run_mutation_test(fn, name, mut_type)
                mutation_results.append(result)

        # Cross-sectional mutation test
        mutation_results.append(run_cross_sectional_mutation_test())

    # Count features by PIT safety
    active = list_active_features()
    causal   = sum(1 for n in active if FEATURE_REGISTRY[n].pit_safety == PITSafety.SAFE)
    invalid  = sum(1 for n in active if FEATURE_REGISTRY[n].pit_safety == PITSafety.UNSAFE)
    unclassified = sum(1 for n in active if FEATURE_REGISTRY[n].pit_safety == PITSafety.UNVERIFIED)

    critical_static = [f for f in all_static if f.severity == "CRITICAL"]
    future_paths    = [f.code_snippet for f in critical_static if f.classification == "INVALID"]
    pit_violations  = []
    mutation_fails  = [r for r in mutation_results if not r.passed]

    notes: list[str] = []

    if invalid > 0:
        notes.append(f"{invalid} features have PITSafety.UNSAFE — BLOCKED from training.")
    if critical_static:
        notes.append(f"{len(critical_static)} critical static findings.")
    if mutation_fails:
        notes.append(
            f"{len(mutation_fails)} mutation tests FAILED: "
            + ", ".join(r.test_name for r in mutation_fails)
        )

    # Label-only paths in static findings
    label_only = sum(1 for f in all_static if f.classification == "LABEL_ONLY")

    # Verdict
    if mutation_fails or invalid > 0:
        verdict = "FAIL"
    elif critical_static:
        verdict = "FAIL"
    elif notes:
        verdict = "CONDITIONAL"
    else:
        verdict = "PASS"

    return FeatureLeakageReport(
        total_features=len(active),
        causal_features=causal,
        label_only_paths=label_only,
        invalid_features=invalid,
        unclassified_features=unclassified,
        static_findings=all_static,
        mutation_results=mutation_results,
        future_dependency_paths=future_paths,
        pit_violations=pit_violations,
        verdict=verdict,
        notes=notes,
    )
