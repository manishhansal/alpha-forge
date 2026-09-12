"""
providers/common/provenance.py — Data Foundation V8 §6/§8/§9.

Provenance tracking + raw data landing zone for every acquisition.

Every persisted dataset carries a DataProvenanceRecord so the system can
always answer:
  WHO provided it?              → provider
  WAS the source authenticated? → authenticated / sourceType
  WHEN was it produced?         → sourceTimestamp
  WHEN was it ingested?         → fetchedAt
  WAS it validated?             → dataTrustStatus
  CAN it be reproduced?         → responseHash / requestId / rawRecord

The RawAcquisitionRecord captures the raw provider response BEFORE any
normalization — sufficient to reproduce the transformation pipeline.

ABSOLUTE RULES:
  - Never persist raw credentials, tokens, or API keys.
  - Use credentialIdentityHash (SHA-256 of the credential) instead.
  - rawResponseJson is optional and size-capped (default 50KB).
  - A dataset with dataTrustStatus=UNVERIFIED must not feed live signals.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

import structlog

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Source type classification
# ---------------------------------------------------------------------------

SOURCE_TYPE_BROKER_AUTHENTICATED    = "BROKER_AUTHENTICATED"
SOURCE_TYPE_OPEN_SOURCE_NSE_DERIVED = "OPEN_SOURCE_NSE_DERIVED"
SOURCE_TYPE_YAHOO_FALLBACK          = "YAHOO_FALLBACK"
SOURCE_TYPE_UNKNOWN                 = "UNKNOWN"

# Mapping: provider → sourceType
_PROVIDER_SOURCE_TYPE: dict[str, str] = {
    "angel_one":  SOURCE_TYPE_BROKER_AUTHENTICATED,
    "upstox":     SOURCE_TYPE_BROKER_AUTHENTICATED,
    "scrapling":  SOURCE_TYPE_BROKER_AUTHENTICATED,
    "jugaad":     SOURCE_TYPE_OPEN_SOURCE_NSE_DERIVED,
    "openchart":  SOURCE_TYPE_OPEN_SOURCE_NSE_DERIVED,
    "yahoo":      SOURCE_TYPE_YAHOO_FALLBACK,
}

# Providers that are broker-authenticated (require + present credentials)
_AUTHENTICATED_PROVIDERS: frozenset[str] = frozenset({
    "angel_one", "upstox", "scrapling"
})


# ---------------------------------------------------------------------------
# Data trust status constants
# ---------------------------------------------------------------------------

TRUST_VERIFIED_RECONCILED    = "VERIFIED_RECONCILED"
TRUST_VERIFIED_SINGLE_SOURCE = "VERIFIED_SINGLE_SOURCE"
TRUST_DEGRADED               = "DEGRADED"
TRUST_UNVERIFIED             = "UNVERIFIED"
TRUST_INVALID                = "INVALID"


# ---------------------------------------------------------------------------
# Dataset version
# ---------------------------------------------------------------------------

def current_dataset_version() -> str:
    """Return today's canonical dataset version string."""
    from datetime import date
    return date.today().strftime("%Y-%m-%d") + "-v1"


# ---------------------------------------------------------------------------
# Credential identity hash (never the raw credential)
# ---------------------------------------------------------------------------

def credential_identity_hash(credential: Optional[str]) -> Optional[str]:
    """
    Return SHA-256 hex of the credential string.
    Returns None if credential is None/empty.
    NEVER logs or persists the raw credential value.
    """
    if not credential:
        return None
    return hashlib.sha256(credential.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Response hash
# ---------------------------------------------------------------------------

def compute_response_hash(data: Any) -> str:
    """
    Compute a deterministic SHA-256 of the response payload.
    `data` can be bytes, str, dict, or list.
    """
    if isinstance(data, bytes):
        raw = data
    elif isinstance(data, str):
        raw = data.encode("utf-8")
    else:
        # Canonical JSON serialization (sorted keys for determinism).
        raw = json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


# ---------------------------------------------------------------------------
# DataProvenanceRecord
# ---------------------------------------------------------------------------

@dataclass
class DataProvenanceRecord:
    """
    Provenance record for one acquired dataset.
    Persisted to the `data_provenance` table via the caller.
    Never contains raw credentials.
    """
    provider:               str
    instrumentId:           str
    exchange:               str
    intervalStr:            str
    sessionDate:            str           # IST YYYY-MM-DD
    fetchedAt:              str           # UTC ISO-8601
    rowCount:               int           = 0
    sourceType:             str           = SOURCE_TYPE_UNKNOWN
    authenticated:          bool          = False
    credentialIdentityHash: Optional[str] = None
    sourceTimestamp:        Optional[str] = None   # provider-declared
    responseHash:           Optional[str] = None
    datasetVersion:         str           = field(default_factory=current_dataset_version)
    instrumentMasterVersion: Optional[str] = None
    parserVersion:          str           = "1"
    normalizationVersion:   str           = "1"
    validationVersion:      str           = "1"
    dataTrustStatus:        str           = TRUST_UNVERIFIED

    @property
    def datasetKey(self) -> str:
        return f"{self.instrumentId}:{self.exchange}:{self.intervalStr}:{self.sessionDate}"

    def to_db_dict(self) -> dict[str, Any]:
        """Return a dict suitable for DB insertion (no internal-only fields)."""
        return {
            "datasetKey":              self.datasetKey,
            "instrumentId":            self.instrumentId,
            "exchange":                self.exchange,
            "intervalStr":             self.intervalStr,
            "sessionDate":             self.sessionDate,
            "provider":                self.provider,
            "sourceType":              self.sourceType,
            "authenticated":           self.authenticated,
            "credentialIdentityHash":  self.credentialIdentityHash,
            "fetchedAt":               self.fetchedAt,
            "sourceTimestamp":         self.sourceTimestamp,
            "responseHash":            self.responseHash,
            "datasetVersion":          self.datasetVersion,
            "instrumentMasterVersion": self.instrumentMasterVersion,
            "parserVersion":           self.parserVersion,
            "normalizationVersion":    self.normalizationVersion,
            "validationVersion":       self.validationVersion,
            "dataTrustStatus":         self.dataTrustStatus,
            "rowCount":                self.rowCount,
        }


def build_provenance(
    provider: str,
    instrument_id: str,
    exchange: str,
    interval_str: str,
    session_date: str,
    row_count: int,
    raw_response: Any = None,
    source_timestamp: Optional[str] = None,
    credential: Optional[str] = None,
    instrument_master_version: Optional[str] = None,
    dataset_version: Optional[str] = None,
) -> DataProvenanceRecord:
    """
    Build a DataProvenanceRecord for a completed acquisition.

    Parameters
    ----------
    provider : str
        Provider ID (e.g. "jugaad", "openchart", "angel_one").
    instrument_id : str
        NSE trading symbol (e.g. "RELIANCE").
    exchange : str
        "NSE" | "NFO" | etc.
    interval_str : str
        Canonical interval string (e.g. "1d", "5m"). "3m" will raise.
    session_date : str
        IST YYYY-MM-DD.
    row_count : int
        Number of candles/rows in this acquisition.
    raw_response : Any, optional
        Raw provider response for hashing (never logged/stored as-is).
    source_timestamp : str, optional
        Provider-declared source time (UTC ISO-8601).
    credential : str, optional
        Raw credential string — hashed, never stored directly.
    instrument_master_version : str, optional
        Universe snapshot version used at acquisition time.
    dataset_version : str, optional
        Override the dataset version string.
    """
    if interval_str == "3m":
        raise ValueError(
            "interval_str='3m' is not supported (permanently removed in V8). "
            "No provenance records will be created for 3m data."
        )

    source_type = _PROVIDER_SOURCE_TYPE.get(provider, SOURCE_TYPE_UNKNOWN)
    authenticated = provider in _AUTHENTICATED_PROVIDERS
    cred_hash = credential_identity_hash(credential) if credential else None
    resp_hash = compute_response_hash(raw_response) if raw_response is not None else None

    return DataProvenanceRecord(
        provider=provider,
        instrumentId=instrument_id,
        exchange=exchange,
        intervalStr=interval_str,
        sessionDate=session_date,
        fetchedAt=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        rowCount=row_count,
        sourceType=source_type,
        authenticated=authenticated,
        credentialIdentityHash=cred_hash,
        sourceTimestamp=source_timestamp,
        responseHash=resp_hash,
        datasetVersion=dataset_version or current_dataset_version(),
        instrumentMasterVersion=instrument_master_version,
    )


# ---------------------------------------------------------------------------
# RawAcquisitionRecord
# ---------------------------------------------------------------------------

@dataclass
class RawAcquisitionRecord:
    """
    Raw landing zone record — captures the provider response before
    transformation. Persisted to `raw_acquisition_record`.
    Max rawResponseJson size: 50KB (truncated beyond that).
    """
    requestId:       str
    provider:        str
    endpoint:        str                 # never contains auth tokens
    instrumentId:    str
    exchange:        str
    intervalStr:     str
    requestParams:   dict[str, Any]      # query params / request body
    requestedAt:     str                 # UTC ISO-8601
    respondedAt:     str                 # UTC ISO-8601
    responseHash:    str
    recordCount:     int                 = 0
    httpStatus:      Optional[int]       = None
    rawResponseJson: Optional[Any]       = None  # truncated to 50KB
    parserVersion:   str                 = "1"

    _MAX_RAW_BYTES: int = 50 * 1024  # 50KB

    def __post_init__(self) -> None:
        # Truncate raw response if too large
        if self.rawResponseJson is not None:
            raw_str = json.dumps(self.rawResponseJson, default=str)
            if len(raw_str.encode("utf-8")) > self._MAX_RAW_BYTES:
                # Store a summary instead of the full payload
                if isinstance(self.rawResponseJson, list):
                    truncated = self.rawResponseJson[:10]
                    self.rawResponseJson = {
                        "__truncated": True,
                        "__total_records": len(self.rawResponseJson),
                        "__sample": truncated,
                    }
                else:
                    self.rawResponseJson = {"__truncated": True, "__reason": "exceeds_50kb"}

    def to_db_dict(self) -> dict[str, Any]:
        return {
            "requestId":       self.requestId,
            "provider":        self.provider,
            "endpoint":        self.endpoint,
            "instrumentId":    self.instrumentId,
            "exchange":        self.exchange,
            "intervalStr":     self.intervalStr,
            "requestParams":   self.requestParams,
            "requestedAt":     self.requestedAt,
            "respondedAt":     self.respondedAt,
            "httpStatus":      self.httpStatus,
            "responseHash":    self.responseHash,
            "rawResponseJson": self.rawResponseJson,
            "recordCount":     self.recordCount,
            "parserVersion":   self.parserVersion,
        }


def build_raw_record(
    provider: str,
    endpoint: str,
    instrument_id: str,
    exchange: str,
    interval_str: str,
    request_params: dict[str, Any],
    raw_response: Any,
    http_status: Optional[int] = None,
    record_count: int = 0,
    request_start_ms: Optional[int] = None,
    request_end_ms: Optional[int] = None,
) -> RawAcquisitionRecord:
    """
    Build a RawAcquisitionRecord for one provider request.
    Endpoint string must NOT contain auth tokens (strip them before calling).
    """
    now_ms = int(time.time() * 1000)
    req_ms = request_start_ms or now_ms
    resp_ms = request_end_ms or now_ms

    return RawAcquisitionRecord(
        requestId=str(uuid.uuid4()),
        provider=provider,
        endpoint=endpoint,
        instrumentId=instrument_id,
        exchange=exchange,
        intervalStr=interval_str,
        requestParams=request_params,
        requestedAt=datetime.fromtimestamp(req_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3] + "Z",
        respondedAt=datetime.fromtimestamp(resp_ms / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S.%f"
        )[:-3] + "Z",
        responseHash=compute_response_hash(raw_response),
        recordCount=record_count,
        httpStatus=http_status,
        rawResponseJson=raw_response,
    )
