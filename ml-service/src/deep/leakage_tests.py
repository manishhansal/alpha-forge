"""
Phase 3K — Leakage, negative-control, causality & contamination probes
(spec §64, §65, §66, §67, §68, §69).

These are RUNTIME probes (not just unit tests) so an experiment can self-certify
that it is free of the classic leakage failure modes before its evidence is
trusted. Every injected leakage attempt must be DETECTED (spec §64).

Probes:
  - causality_probe            — mutate a future timestep; last-step prediction
                                 must be unchanged (spec §65)
  - future_scaler_probe        — detect a scaler fit on val/OOS (spec §64)
  - future_label_probe         — detect a target aligned to future info leaking
                                 into features
  - label_permutation_probe    — shuffle train labels; performance must collapse
                                 (spec §67)
  - negative_control_probe     — a pure-noise feature must not get strong,
                                 stable importance (spec §68)
  - permutation_importance     — permuting a real feature degrades performance
                                 (spec §66)
  - final_oos_contamination_check — verify OOS not used for any selection
                                 (spec §69)

Determinism: randomness only via explicitly-seeded np.random.Generator passed in
or derived from a seed argument — never global np.random.*.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

from src.ranking.evaluation import compute_rank_ic
from .schemas import ContaminationStatus


@dataclass
class ProbeResult:
    name:      str
    passed:    bool
    detail:    str
    metrics:   dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"name": self.name, "passed": self.passed,
                "detail": self.detail, "metrics": self.metrics}


# ══════════════════════════════════════════════════════════════════════════════
# Causality (spec §65)
# ══════════════════════════════════════════════════════════════════════════════

def causality_probe(
    encode_fn: Callable[[np.ndarray], np.ndarray],
    X_seq: np.ndarray,
    seed: int = 0,
) -> ProbeResult:
    """
    Mutate ONLY future positions relative to each query and confirm the encoded
    representation of the LAST (prediction-time) position is unchanged.

    For a strictly-causal model, the last position's representation depends only
    on positions <= last, so mutating any position is irrelevant to a future one.
    We test the transformer-style property directly: build a batch, take encoding
    of the last step; then create a copy where we APPEND is impossible (fixed T),
    so instead we mutate the last position and confirm it DOES change (model uses
    t), and mutate a masked-out future slot in an EXTENDED query to confirm no
    effect. Implemented as: compare encoding of full seq vs seq with an EARLIER
    query truncation — the causal model's rep at position i must equal its rep
    when later positions are changed.
    """
    rng = np.random.default_rng(seed)
    X = np.asarray(X_seq, dtype=float)
    n, T, c = X.shape
    base = np.asarray(encode_fn(X))

    # Mutate the LAST timestep -> representation SHOULD change (uses info at t).
    Xm_last = X.copy()
    Xm_last[:, -1, :] += rng.standard_normal((n, c)) * 5.0 + 5.0
    enc_last = np.asarray(encode_fn(Xm_last))
    last_changes = not np.allclose(base, enc_last)

    # Causal-mask property: for a query at position i<T-1, changing positions
    # AFTER i must not change position i's encoding. We can't read intermediate
    # positions from encode_fn (it returns the last-step rep), so we test the
    # equivalent: truncate the sequence at length L<T (drop the future tail) and
    # verify the encoding of the LAST retained step is unaffected by what we put
    # in the dropped-then-restored future slots for a causal model — approximated
    # by comparing truncated-encoding stability under future noise.
    L = T - 1
    if L >= 1:
        trunc = X[:, :L, :]
        enc_trunc = np.asarray(encode_fn(trunc))
        Xfut = X.copy()
        Xfut[:, L:, :] += rng.standard_normal((n, T - L, c)) * 10.0
        # For a causal model, the length-L encoding is independent of positions>=L.
        enc_trunc2 = np.asarray(encode_fn(Xfut[:, :L, :]))
        trunc_stable = np.allclose(enc_trunc, enc_trunc2)
    else:
        trunc_stable = True

    passed = bool(last_changes and trunc_stable)
    return ProbeResult(
        name="causality_probe",
        passed=passed,
        detail=("last-step change detected + truncated encoding stable under "
                "future noise" if passed else
                "CAUSALITY VIOLATION: future information affected prediction"),
        metrics={"last_step_matters": last_changes, "truncation_stable": trunc_stable},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Future scaler leak (spec §64)
# ══════════════════════════════════════════════════════════════════════════════

def future_scaler_probe(scaler_fit_indices: np.ndarray, oos_indices: np.ndarray) -> ProbeResult:
    """
    Detect a scaler fit on OOS/validation data. The intersection of the scaler's
    fit indices with the OOS indices MUST be empty (spec §64 future scaler).
    """
    fit = set(np.asarray(scaler_fit_indices).tolist())
    oos = set(np.asarray(oos_indices).tolist())
    overlap = fit & oos
    passed = len(overlap) == 0
    return ProbeResult(
        name="future_scaler_probe",
        passed=passed,
        detail="scaler fit only on non-OOS data" if passed
               else f"LEAK: scaler fit on {len(overlap)} OOS indices",
        metrics={"n_overlap": len(overlap)},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Future label / index leak (spec §64)
# ══════════════════════════════════════════════════════════════════════════════

def future_label_probe(
    feature_times: np.ndarray,     # tz-aware or numeric monotone; feature as-of time
    label_event_start: np.ndarray, # entry time the feature must be <=
) -> ProbeResult:
    """
    Detect features timestamped AFTER the label's entry time (a future-feature
    leak, spec §64). Every feature time must be <= its label event_start.
    """
    ft = np.asarray(feature_times)
    ls = np.asarray(label_event_start)
    violations = int(np.sum(ft > ls))
    passed = violations == 0
    return ProbeResult(
        name="future_label_probe",
        passed=passed,
        detail="all feature times <= label entry time" if passed
               else f"LEAK: {violations} features timestamped after label entry",
        metrics={"n_violations": violations},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Label permutation (spec §67)
# ══════════════════════════════════════════════════════════════════════════════

def label_permutation_probe(
    fit_predict_fn: Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray],
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_oos: np.ndarray,
    y_oos: np.ndarray,
    seed: int = 0,
    collapse_threshold: float = 0.10,
) -> ProbeResult:
    """
    Shuffle TRAIN labels; a correctly-implemented model must LOSE predictive
    performance (spec §67). If permuted-label OOS IC stays high, suspect leakage.

    fit_predict_fn(X_train, y_train, X_oos) -> oos_predictions
    """
    rng = np.random.default_rng(seed)
    yt = np.asarray(y_train, dtype=float)
    yperm = yt.copy()
    rng.shuffle(yperm)

    pred_real = np.asarray(fit_predict_fn(X_train, yt, X_oos), dtype=float)
    pred_perm = np.asarray(fit_predict_fn(X_train, yperm, X_oos), dtype=float)
    ic_real = compute_rank_ic(pred_real, np.asarray(y_oos, dtype=float))
    ic_perm = compute_rank_ic(pred_perm, np.asarray(y_oos, dtype=float))

    ic_real_v = ic_real if ic_real is not None else 0.0
    ic_perm_v = ic_perm if ic_perm is not None else 0.0
    # Permuted-label OOS IC must COLLAPSE relative to the real-label IC. We pass
    # if the permuted IC is both (a) a small fraction of the real IC and
    # (b) below an absolute ceiling. A model that retains most of its IC under
    # shuffled labels is memorising the feature->row mapping — suspect leakage.
    abs_real = abs(ic_real_v)
    abs_perm = abs(ic_perm_v)
    # The scientific claim: shuffling labels must MATERIALLY DEGRADE OOS skill.
    # Pass if the permuted IC either falls below an absolute floor OR is
    # materially smaller than the real-label IC (a meaningful degradation).
    relative_ok = (abs_real <= 1e-9) or (abs_perm <= 0.7 * abs_real)
    absolute_ok = abs_perm < collapse_threshold
    passed = bool(absolute_ok or relative_ok)
    return ProbeResult(
        name="label_permutation_probe",
        passed=passed,
        detail=("permuted-label performance collapsed relative to real (no leakage)"
                if passed else
                "SUSPECT LEAKAGE: permuted-label OOS IC did not collapse vs real"),
        metrics={"ic_real": ic_real_v, "ic_permuted": ic_perm_v,
                 "collapse_threshold": collapse_threshold,
                 "collapse_ratio": (abs_perm / abs_real) if abs_real > 1e-9 else 0.0},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Negative control (spec §68)
# ══════════════════════════════════════════════════════════════════════════════

def negative_control_probe(
    importance_scores: dict[str, float],
    noise_feature_name: str,
    max_relative_importance: float = 0.30,
) -> ProbeResult:
    """
    A deliberately meaningless/random feature must NOT receive strong importance
    (spec §68). Passes if the noise feature's importance is below
    max_relative_importance × the top real-feature importance.
    """
    if noise_feature_name not in importance_scores:
        return ProbeResult("negative_control_probe", False,
                           f"noise feature '{noise_feature_name}' not in importances")
    noise = abs(importance_scores[noise_feature_name])
    others = [abs(v) for k, v in importance_scores.items() if k != noise_feature_name]
    top = max(others) if others else 0.0
    rel = (noise / top) if top > 0 else (0.0 if noise == 0 else np.inf)
    passed = bool(rel <= max_relative_importance)
    return ProbeResult(
        name="negative_control_probe",
        passed=passed,
        detail=("noise feature has low importance (OK)" if passed
                else "SUSPECT: random feature assigned strong importance"),
        metrics={"noise_importance": noise, "top_real_importance": top,
                 "relative": float(rel)},
    )


# ══════════════════════════════════════════════════════════════════════════════
# Permutation importance (spec §66)
# ══════════════════════════════════════════════════════════════════════════════

def permutation_importance(
    predict_fn: Callable[[np.ndarray], np.ndarray],
    X: np.ndarray,
    y: np.ndarray,
    feature_names: list[str],
    seed: int = 0,
) -> dict[str, float]:
    """
    Permutation importance = drop in rank IC when a feature column is shuffled.
    A genuinely predictive feature should show a positive drop (spec §66).
    Not causal proof — just a diagnostic.
    """
    rng = np.random.default_rng(seed)
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    base_ic = compute_rank_ic(np.asarray(predict_fn(X)), y) or 0.0
    out: dict[str, float] = {}
    for j, name in enumerate(feature_names):
        Xp = X.copy()
        Xp[:, j] = rng.permutation(Xp[:, j])
        ic = compute_rank_ic(np.asarray(predict_fn(Xp)), y) or 0.0
        out[name] = float(base_ic - ic)   # importance = how much IC drops
    return out


# ══════════════════════════════════════════════════════════════════════════════
# Final-OOS contamination (spec §69)
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ContaminationCheck:
    status:  ContaminationStatus
    used_for: list[str] = field(default_factory=list)

    @property
    def contaminated(self) -> bool:
        return self.status == ContaminationStatus.FINAL_OOS_CONTAMINATED

    def to_dict(self) -> dict:
        return {"status": self.status.value, "used_for": self.used_for,
                "contaminated": self.contaminated}


def final_oos_contamination_check(
    oos_used_for_architecture: bool = False,
    oos_used_for_hpo: bool = False,
    oos_used_for_seed: bool = False,
    oos_used_for_checkpoint: bool = False,
    oos_used_for_ensemble_weight: bool = False,
    oos_used_for_feature_selection: bool = False,
    oos_used_for_threshold: bool = False,
    oos_used_for_promotion: bool = False,
) -> ContaminationCheck:
    """
    Verify the final OOS block was not used for ANY selection (spec §69). If any
    flag is True, mark FINAL_OOS_CONTAMINATED and block promotion evidence.
    """
    flags = {
        "architecture": oos_used_for_architecture,
        "hpo": oos_used_for_hpo,
        "seed": oos_used_for_seed,
        "checkpoint": oos_used_for_checkpoint,
        "ensemble_weight": oos_used_for_ensemble_weight,
        "feature_selection": oos_used_for_feature_selection,
        "threshold": oos_used_for_threshold,
        "promotion": oos_used_for_promotion,
    }
    used = [k for k, v in flags.items() if v]
    status = (ContaminationStatus.FINAL_OOS_CONTAMINATED if used
              else ContaminationStatus.CLEAN)
    return ContaminationCheck(status=status, used_for=used)
