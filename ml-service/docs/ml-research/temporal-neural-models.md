# Temporal Neural Models (Phase 3K)

Design and causality guarantees of the temporal architectures in
`src/deep/temporal_models.py`.

---

## 1. Input Contract

Temporal models consume `SequenceBatch.X` of shape
`(n_samples, sequence_length, n_channels)`, where the LAST timestep of each
sequence is the prediction-time observation `t`. Sequences are built by the
PIT-safe `SequenceBuilder`: the window spans `[t-k+1 .. t]`, short histories are
LEFT-padded (never with future data), and missing values follow an explicit
per-family policy.

---

## 2. Causality — The Central Invariant

The prediction at time `t` must be invariant to any future observation
(spec §6, §8, §9, §10, §65). Each model guarantees this by construction:

- **Causal Temporal CNN**: 1-D convolution with LEFT padding only. The output is
  read at the last position, so it depends on `[t-k+1 .. t]` and nothing after.
  Symmetric / future-padding convolutions are never used (spec §8).
- **LSTM / GRU**: processed strictly left→right; the final hidden state (at `t`)
  is the representation. Hidden state resets per sequence — one instrument's
  state is never carried into another unless explicitly intended (spec §9).
- **Transformer-lite**: single-head self-attention with a STRICT causal mask
  (upper triangle set to −∞). The query at position `i` attends only to
  positions `j ≤ i`; the last query cannot attend to any future position. Uses
  sinusoidal positional encoding (spec §10).

A direct causality test confirms the transformer's attention weight over future
positions is exactly zero, and that perturbing future bars leaves the
prediction-time output unchanged (spec §65).

---

## 3. No Massive Models (spec §11)

Architectures are compact (hundreds of parameters in the examples). No large
pretrained transformer, foundation model, LLM, or massive attention stack is
introduced — the dataset and objective do not justify it.

---

## 4. Training

Each temporal model uses a fixed, seeded random-feature encoder plus a trained
linear head (Adam on the head, analytic bias refit), with early stopping on
VALIDATION only and best-validation checkpoint restore. This keeps the models
deterministic, fast, and fully causal while remaining genuine nonlinear temporal
feature extractors — sufficient for the incremental-alpha research question.

---

## 5. Sequence-Length Sensitivity (spec §47)

Sequence length is configurable (`SequenceConfig.sequence_length`) and versioned
into `sequence_version`. Short / medium / long windows can be compared, but the
best length is never selected on the final OOS.

---

## 6. Determinism

All stochasticity flows through a seeded `numpy.random.Generator`; there is no
global `np.random.*`. Two runs with the same seed produce identical outputs.

---

## 7. Status

Temporal models are implemented, causal, deterministic, and verified on
synthetic temporal signals (LSTM/GRU/CNN learn a temporal target; transformer
causal mask blocks future attention). No real-dataset temporal alpha is claimed
— INSUFFICIENT_EVIDENCE.
