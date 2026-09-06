"""
AlphaForge ML Service — Point-in-Time Data Foundation.

This package provides the data contracts, validators, and stores required to
ensure that every ML observation respects the fundamental invariant:

    available_time <= prediction_time

No feature value may depend on information that was not available to a
trader at the time the prediction was made.

Modules
-------
point_in_time
    Core PIT record, timestamp helpers, PointInTimeValidator.
lineage
    MLObservationLineage, DatasetLineage — per-observation and per-dataset
    traceability without duplicating data-service live-signal infrastructure.
dataset_version
    DatasetSnapshot — full provenance record for every training artefact.
instrument_master
    HistoricalInstrumentRecord, InstrumentMasterStore — instrument metadata
    with effective dates (not today-only like data-service).
historical_universe
    UniverseMembership, HistoricalUniverse — PIT universe with 5 independent
    boolean dimensions; replaces static TRAINING_UNIVERSE list.
corporate_actions
    CorporateActionRecord, CorporateActionStore — splits, bonuses, mergers
    with availability timestamps; explicit DATA_UNAVAILABLE policy.
fno_eligibility
    FnOEligibilityRecord, FnOBanRecord, FnOStateStore — historical F&O ban
    and MWPL state with DATA_UNAVAILABLE when history is absent.
data_quality
    MLDataQualityIssue, MLDataQualityReport, MLDataQualityGate — batch
    quality gate for ML datasets, distinct from live-signal DataQualityGate.
"""

from __future__ import annotations
