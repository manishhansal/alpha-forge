# Phase 3K — Model Complexity Report

**Generated:** 2026-09-06  
**Branch:** `refactor/improve-ml-service`

---

## 1. Structured Complexity (spec §41, §79)

Complexity is reported as a STRUCTURED class (LOW / MODERATE / HIGH / VERY_HIGH)
from documented criteria — never a subjective numeric penalty. Criteria:
parameter count, sequential recurrence, attention mechanism, GPU requirement,
dependency count.

| Model | Class | Trigger criteria |
|-------|-------|------------------|
| MLP (257 params) | LOW | small model |
| Temporal CNN | LOW–MODERATE | small / causal conv |
| LSTM / GRU | MODERATE | sequential recurrence |
| Transformer-lite | HIGH | attention mechanism |
| (hypothetical) large GPU attention >1M params | VERY_HIGH | large + GPU + attention |

Each `ComplexityProfile` also records debuggability and operational-risk labels.

---

## 2. Latency (spec §42)

`measure_latency` reports mean / median / p95 / p99 inference latency in ms;
p95/p99 are reported only with ≥20 observations. Measured on the research
machine (CPU, arm64); the profile explicitly notes production hardware may
differ (spec §42).

The pure-NumPy models are sub-millisecond per inference on the research machine.

---

## 3. Model Size (spec §43)

`state_bytes()` gives the serialized parameter size; the MLP example is ~2 KB.
Large models must justify their operational cost — none in this phase are large.

---

## 4. Data Requirement / Sample Efficiency (spec §44, §45)

The multi-seed / walk-forward apparatus supports evaluating models under reduced
training history to assess data hunger. No real dataset is loaded, so a
production data-hunger curve is not reported (INSUFFICIENT_EVIDENCE).

---

## 5. Complexity-Adjusted Decision (spec §79)

The final recommendation compares incremental alpha against incremental
complexity using structured evidence, not a single number. Since the current
verdict is NO_INCREMENTAL_ALPHA, no model justifies its added complexity: the
compact classical baseline remains preferred.

---

## 6. Verdict

All implemented models are LOW–HIGH complexity (no VERY_HIGH). Given
NO_INCREMENTAL_ALPHA, none of the added complexity is currently justified over
the classical baseline. INSUFFICIENT_EVIDENCE for a production complexity
trade-off decision.
