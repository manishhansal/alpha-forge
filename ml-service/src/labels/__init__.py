"""
AlphaForge Label V2 — Canonical Event-Based Target Engineering.

This package is the single source of truth for all ML labels in AlphaForge.
There must be no duplicate label implementations in model-specific files.

Label hierarchy
---------------
Fixed-horizon labels       labels/fixed_horizon.py
Triple-barrier labels      labels/triple_barrier.py
Meta-labels                labels/meta_label.py
Risk outcomes (MFE/MAE)    labels/risk_outcomes.py
Relative/excess returns    labels/relative.py
Sample weight metadata     labels/sample_weights.py
Schemas (data contracts)   labels/schemas.py
Configuration              labels/config.py
Validators                 labels/validators.py
Registry                   labels/registry.py

PIT invariants
--------------
Features:  data available at prediction_time  (enforced by Phase 3A/3B)
Labels:    may use future prices — that IS the point.
           Future information must NEVER leak back into features.

Every LabelEvent carries:
  event_start_time   when the observation was made / trade entered
  event_end_time     when the outcome was realised
  label_available_time  same as event_end_time for offline training
"""

from __future__ import annotations
