"""
Phase 3Q — Security redaction (spec §28).

Broker credentials (Angel One / Upstox API key, secret, access-token,
refresh-token) must NEVER reach a browser/frontend, a commit, a log line, or an
error message. This module provides deterministic redaction for auth headers,
provider response payloads, and free-form strings, plus a scanner that flags
credential-shaped material. Redaction NEVER echoes the secret value — it replaces
it with a fixed marker.
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "***REDACTED***"

# Case-insensitive credential key fragments (spec §28). A dict key containing any
# of these has its value redacted regardless of nesting depth.
_SECRET_KEY_FRAGMENTS = (
    "api_key", "apikey", "api-secret", "secret", "access_token", "accesstoken",
    "refresh_token", "refreshtoken", "authorization", "auth_token", "password",
    "private_key", "session_token", "client_secret", "totp", "feed_token",
    "jwt", "bearer",
)

# Header names that always carry credentials.
_SECRET_HEADERS = ("authorization", "x-api-key", "x-auth-token", "cookie",
                   "x-privatekey", "x-access-token")

# Patterns of credential-shaped values inside free text (redacted defensively).
_TOKEN_PATTERNS = (
    re.compile(r"Bearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9._\-]{10,}"),          # JWT-ish
)


def _is_secret_key(key: str) -> bool:
    k = key.lower().replace("-", "_")
    return any(frag.replace("-", "_") in k for frag in _SECRET_KEY_FRAGMENTS)


def redact_mapping(data: Any) -> Any:
    """
    Recursively redact any dict values whose key looks like a credential.
    Lists/tuples are traversed; scalars pass through (string scalars still get
    token-pattern scrubbing via `redact_text`). Never mutates the input.
    """
    if isinstance(data, dict):
        return {k: (REDACTED if _is_secret_key(str(k)) else redact_mapping(v))
                for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        seq = [redact_mapping(v) for v in data]
        return type(data)(seq) if isinstance(data, tuple) else seq
    if isinstance(data, str):
        return redact_text(data)
    return data


def redact_headers(headers: dict[str, Any]) -> dict[str, Any]:
    """Redact known credential-bearing HTTP headers (spec §28)."""
    out: dict[str, Any] = {}
    for k, v in headers.items():
        if k.lower() in _SECRET_HEADERS or _is_secret_key(str(k)):
            out[k] = REDACTED
        else:
            out[k] = redact_text(v) if isinstance(v, str) else v
    return out


def redact_text(text: str) -> str:
    """Scrub credential-shaped substrings from free text / error messages."""
    scrubbed = text
    for pat in _TOKEN_PATTERNS:
        scrubbed = pat.sub(REDACTED, scrubbed)
    return scrubbed


def contains_secret(data: Any) -> bool:
    """
    True if `data` (dict/list/str) appears to carry a credential. Used by tests
    and the health-API guard to fail-closed if a payload would leak a secret.
    """
    if isinstance(data, dict):
        for k, v in data.items():
            if _is_secret_key(str(k)) and v not in (None, "", REDACTED):
                return True
            if contains_secret(v):
                return True
        return False
    if isinstance(data, (list, tuple)):
        return any(contains_secret(v) for v in data)
    if isinstance(data, str):
        return any(pat.search(data) for pat in _TOKEN_PATTERNS)
    return False
