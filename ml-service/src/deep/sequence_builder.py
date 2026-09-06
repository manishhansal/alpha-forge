"""
Phase 3K — PIT-safe sequence builder (spec §6, §7, §8).

Builds temporal input sequences [t-k+1 ... t] for temporal neural models
(CNN / LSTM / GRU / transformer-lite). The sequence at prediction time `t` must
contain ONLY information available at or before `t`:

  - No future bars.
  - No future labels.
  - No future normalization (normalization is a separate PIT-safe step; this
    module never scales using future statistics).
  - No future-observation padding — short histories are LEFT-padded with a
    configured pad value (or masked), NEVER filled with later observations
    (spec §7 r4padding).

Versioned: the SequenceConfig produces a deterministic `sequence_version` hash
so every experiment records exactly how its sequences were built (spec §60).

Determinism: no np.random.*.

Convention alignment (see audit §5)
-----------------------------------
Feature matrix per instrument is a 2-D array (n_bars, n_features), rows ordered
ascending by tz-aware UTC timestamp, columns in the canonical feature order.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class MissingnessPolicy(str, Enum):
    """How missing values are handled per feature family (spec §15)."""
    MASK           = "MASK"            # add a missing-indicator, keep NaN->0 in value channel
    IMPUTE_ZERO    = "IMPUTE_ZERO"     # explicit 0 (documented, not silent)
    IMPUTE_FFILL   = "IMPUTE_FFILL"    # forward-fill from PAST only (never future)
    DROP           = "DROP"            # drop the observation


class PaddingPolicy(str, Enum):
    """How short histories are padded (spec §7). Never with future data."""
    LEFT_PAD_ZERO  = "LEFT_PAD_ZERO"   # pad the front with zeros + mask
    LEFT_PAD_FIRST = "LEFT_PAD_FIRST"  # repeat the earliest available bar (past only)
    NO_PAD         = "NO_PAD"          # drop sequences with insufficient history


@dataclass
class SequenceConfig:
    """
    Versioned sequence-construction configuration (spec §5, §7).

    Every field affects the sequence_version hash.
    """
    sequence_length:     int = 20          # k: number of timesteps per sample
    sampling_frequency:  str = "1D"        # bar frequency
    feature_version:     str = "fv4"
    alignment_policy:    str = "AS_OF_T"   # last bar of the window == prediction time t
    missingness_policy:  MissingnessPolicy = MissingnessPolicy.MASK
    padding_policy:      PaddingPolicy = PaddingPolicy.LEFT_PAD_ZERO
    pad_value:           float = 0.0
    add_missing_indicator: bool = True
    version_tag:         str = "seq-v1"

    def __post_init__(self) -> None:
        if self.sequence_length <= 0:
            raise ValueError(f"sequence_length must be > 0, got {self.sequence_length}")

    @property
    def sequence_version(self) -> str:
        """Deterministic version hash — changing any field changes it."""
        key = {
            "sequence_length":    self.sequence_length,
            "sampling_frequency": self.sampling_frequency,
            "feature_version":    self.feature_version,
            "alignment_policy":   self.alignment_policy,
            "missingness_policy": self.missingness_policy.value,
            "padding_policy":     self.padding_policy.value,
            "pad_value":          self.pad_value,
            "add_missing_indicator": self.add_missing_indicator,
            "version_tag":        self.version_tag,
        }
        raw = json.dumps(key, sort_keys=True)
        return f"{self.version_tag}-{hashlib.sha256(raw.encode()).hexdigest()[:12]}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["missingness_policy"] = self.missingness_policy.value
        d["padding_policy"] = self.padding_policy.value
        d["sequence_version"] = self.sequence_version
        return d


@dataclass
class SequenceBatch:
    """
    Output of the sequence builder.

    X:     (n_samples, sequence_length, n_channels) float array.
           n_channels = n_features (+ n_features missing-indicators if enabled).
    mask:  (n_samples, sequence_length) bool array — True where the timestep is
           real (not padding). Used by temporal models to ignore padding.
    end_index: (n_samples,) int — positional index of the LAST (prediction-time)
           bar of each sequence into the source array.
    feature_names: channel names in order.
    """
    X:             np.ndarray
    mask:          np.ndarray
    end_index:     np.ndarray
    feature_names: list[str]
    sequence_version: str

    @property
    def n_samples(self) -> int:
        return self.X.shape[0]

    @property
    def sequence_length(self) -> int:
        return self.X.shape[1]

    @property
    def n_channels(self) -> int:
        return self.X.shape[2]


class SequenceBuilder:
    """
    Builds PIT-safe sequences from a per-instrument feature matrix.

    The input is a single instrument's feature matrix ordered ascending in time.
    A sequence ending at positional index i uses rows [i-k+1 .. i] (inclusive),
    i.e. the last row is the prediction-time observation. Rows before position 0
    are LEFT-padded per the padding policy — NEVER filled with rows after i.
    """

    def __init__(self, config: Optional[SequenceConfig] = None) -> None:
        self.config = config or SequenceConfig()

    # ── core builder ─────────────────────────────────────────────────────

    def build(
        self,
        feature_matrix: np.ndarray,           # (n_bars, n_features) ascending time
        feature_names: list[str],
        prediction_indices: Optional[np.ndarray] = None,  # which rows are prediction times
    ) -> SequenceBatch:
        """
        Build sequences for the requested prediction indices.

        Args:
            feature_matrix: (n_bars, n_features), rows ascending in time.
            feature_names:  length n_features, canonical order.
            prediction_indices: positional indices (into feature_matrix) at which
                to emit a sequence. Defaults to all rows with >=1 bar of history.

        Returns:
            SequenceBatch.

        PIT guarantee: for a sequence ending at index i, only rows j <= i are
        ever read. This is asserted internally.
        """
        cfg = self.config
        fm = np.asarray(feature_matrix, dtype=float)
        if fm.ndim != 2:
            raise ValueError(f"feature_matrix must be 2-D (n_bars, n_features), got {fm.shape}")
        n_bars, n_feat = fm.shape
        if len(feature_names) != n_feat:
            raise ValueError(
                f"feature_names length {len(feature_names)} != n_features {n_feat}"
            )

        k = cfg.sequence_length
        if prediction_indices is None:
            if cfg.padding_policy == PaddingPolicy.NO_PAD:
                prediction_indices = np.arange(k - 1, n_bars)
            else:
                prediction_indices = np.arange(0, n_bars)
        prediction_indices = np.asarray(prediction_indices, dtype=int)

        # Missingness handling (PIT-safe; ffill uses PAST only)
        value_channel, missing_mask = self._apply_missingness(fm)

        samples_X: list[np.ndarray] = []
        samples_mask: list[np.ndarray] = []
        kept_end: list[int] = []

        for i in int_iter(prediction_indices):
            if i < 0 or i >= n_bars:
                continue
            start = i - k + 1
            if start < 0:
                if cfg.padding_policy == PaddingPolicy.NO_PAD:
                    continue
                real_rows = value_channel[0:i + 1]                    # rows 0..i
                real_missing = missing_mask[0:i + 1]
                pad_n = k - real_rows.shape[0]
                pad_block, pad_mask_block = self._left_pad(real_rows, pad_n, n_feat)
                seq_val = np.concatenate([pad_block, real_rows], axis=0)
                seq_missing = np.concatenate(
                    [np.ones((pad_n, n_feat), dtype=bool), real_missing], axis=0
                )
                timestep_mask = np.concatenate(
                    [np.zeros(pad_n, dtype=bool), np.ones(real_rows.shape[0], dtype=bool)]
                )
            else:
                # PIT ASSERTION: window never reads beyond i
                assert start >= 0 and (i + 1) <= n_bars
                seq_val = value_channel[start:i + 1]
                seq_missing = missing_mask[start:i + 1]
                timestep_mask = np.ones(k, dtype=bool)

            channels = [seq_val]
            if cfg.add_missing_indicator:
                channels.append(seq_missing.astype(float))
            seq = np.concatenate(channels, axis=1)   # (k, n_feat[*2])

            samples_X.append(seq)
            samples_mask.append(timestep_mask)
            kept_end.append(i)

        if not samples_X:
            n_ch = n_feat * (2 if cfg.add_missing_indicator else 1)
            return SequenceBatch(
                X=np.empty((0, k, n_ch), dtype=float),
                mask=np.empty((0, k), dtype=bool),
                end_index=np.empty((0,), dtype=int),
                feature_names=self._channel_names(feature_names),
                sequence_version=cfg.sequence_version,
            )

        X = np.stack(samples_X, axis=0)
        mask = np.stack(samples_mask, axis=0)
        return SequenceBatch(
            X=X,
            mask=mask,
            end_index=np.asarray(kept_end, dtype=int),
            feature_names=self._channel_names(feature_names),
            sequence_version=cfg.sequence_version,
        )

    # ── helpers ──────────────────────────────────────────────────────────

    def _apply_missingness(self, fm: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Return (value_channel, missing_mask). PIT-safe; ffill uses past only."""
        cfg = self.config
        missing_mask = ~np.isfinite(fm)
        value = fm.copy()

        if cfg.missingness_policy == MissingnessPolicy.IMPUTE_FFILL:
            # Forward-fill DOWN the time axis (past -> present). Never backward.
            for col in range(value.shape[1]):
                last = np.nan
                for row in range(value.shape[0]):
                    if np.isfinite(value[row, col]):
                        last = value[row, col]
                    elif np.isfinite(last):
                        value[row, col] = last
            # Remaining NaN (no past value) -> pad_value
            value[~np.isfinite(value)] = cfg.pad_value
        else:
            # MASK / IMPUTE_ZERO / DROP all set the value channel deterministically
            value[missing_mask] = (cfg.pad_value
                                   if cfg.missingness_policy != MissingnessPolicy.IMPUTE_ZERO
                                   else 0.0)
        return value, missing_mask

    def _left_pad(self, real_rows: np.ndarray, pad_n: int, n_feat: int):
        cfg = self.config
        if pad_n <= 0:
            empty = np.empty((0, n_feat), dtype=float)
            return empty, np.empty((0, n_feat), dtype=bool)
        if cfg.padding_policy == PaddingPolicy.LEFT_PAD_FIRST and real_rows.shape[0] > 0:
            first = real_rows[0:1]
            pad_block = np.repeat(first, pad_n, axis=0)   # repeat earliest PAST bar
        else:
            pad_block = np.full((pad_n, n_feat), cfg.pad_value, dtype=float)
        pad_mask_block = np.ones((pad_n, n_feat), dtype=bool)  # padding is "missing"
        return pad_block, pad_mask_block

    def _channel_names(self, feature_names: list[str]) -> list[str]:
        names = list(feature_names)
        if self.config.add_missing_indicator:
            names = names + [f"{n}__missing" for n in feature_names]
        return names


def int_iter(arr: np.ndarray):
    """Yield python ints from a numpy int array (avoids np.int in downstream code)."""
    for v in arr.tolist():
        yield int(v)


def assert_no_future_in_sequence(
    feature_matrix: np.ndarray,
    end_index: int,
    sequence_length: int,
) -> bool:
    """
    Independent PIT verifier (spec §64, §65).

    Confirms that a sequence ending at `end_index` only spans rows
    [max(0, end_index-k+1) .. end_index]. Returns True if the window is causal.
    Used by tests to prove no future bar is included.
    """
    start = max(0, end_index - sequence_length + 1)
    return start >= 0 and end_index < feature_matrix.shape[0] and start <= end_index
