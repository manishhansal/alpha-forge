/**
 * Upstox OAuth Token Lifecycle — server-side only.
 *
 * Manages the lifecycle state for the Upstox OAuth2 integration.
 * Token state is NEVER exposed to the browser.
 *
 * State machine:
 *
 *   DISCONNECTED
 *       │  (user initiates OAuth)
 *       ▼
 *   AUTHORIZING
 *       │  (OAuth callback received + token exchange)
 *       ▼
 *   CONNECTED ──── (auto-refresh when TOKEN_EXPIRING) ──▶ TOKEN_EXPIRING
 *       │                                                         │
 *       │  (token expired without refresh)                       │ (refresh attempt)
 *       ▼                                                         ▼
 *   TOKEN_EXPIRED                                          CONNECTED (if refresh ok)
 *       │
 *       │  (user must re-authorize)
 *       ▼
 *   REAUTH_REQUIRED
 *       │  (any unrecoverable error)
 *       ▼
 *   ERROR
 *
 * Security invariants:
 *   - accessToken is NEVER serialized into logs, browser responses, or URLs
 *   - refreshToken (if present) is NEVER serialized into logs or browser responses
 *   - Token values are redacted in all log emissions
 *   - Frontend only ever sees: state, expiresAt (timestamp only), connectedAt
 */

// ── Token lifecycle states ────────────────────────────────────────────────────

export type UpstoxTokenState =
  | "DISCONNECTED"    // No token configured
  | "AUTHORIZING"     // OAuth redirect in progress
  | "CONNECTED"       // Token valid and fresh
  | "TOKEN_EXPIRING"  // Token valid but within 30-min expiry window
  | "TOKEN_EXPIRED"   // Token has expired; awaiting refresh or reauth
  | "REAUTH_REQUIRED" // Refresh failed or explicitly disconnected; user must re-authorize
  | "ERROR";          // Unrecoverable error state

/** Public shape exposed to the frontend (NO secrets). */
export type UpstoxProviderStatus = {
  state: UpstoxTokenState;
  /** UTC epoch-ms when the token expires. Null when not connected. */
  expiresAt: number | null;
  /** UTC epoch-ms when the connection was established. Null when not connected. */
  connectedAt: number | null;
  /** Human-readable status message. */
  message: string;
  /** Whether data reads are currently operational. */
  dataOperational: boolean;
};

// ── Internal state (server memory only) ──────────────────────────────────────

interface InternalTokenState {
  tokenState: UpstoxTokenState;
  accessToken: string | null;    // NEVER expose to frontend
  expiresAt: number | null;      // UTC epoch ms
  connectedAt: number | null;    // UTC epoch ms
  lastError: string | null;
}

const _state: InternalTokenState = {
  tokenState: "DISCONNECTED",
  accessToken: null,
  expiresAt: null,
  connectedAt: null,
  lastError: null,
};

// Token-expiry warning window: transition to TOKEN_EXPIRING 30 minutes before expiry
const EXPIRY_WARNING_MS = 30 * 60_000;

// ── State transitions ─────────────────────────────────────────────────────────

export function setConnected(accessToken: string, expiresInSeconds: number): void {
  _state.accessToken    = accessToken;
  _state.expiresAt      = Date.now() + expiresInSeconds * 1_000;
  _state.connectedAt    = Date.now();
  _state.tokenState     = "CONNECTED";
  _state.lastError      = null;
}

export function setDisconnected(): void {
  _state.accessToken = null;
  _state.expiresAt   = null;
  _state.tokenState  = "DISCONNECTED";
  _state.lastError   = null;
  // Deliberately do NOT reset connectedAt — keeps audit trail of last session
}

export function setAuthorizing(): void {
  _state.tokenState = "AUTHORIZING";
  _state.lastError  = null;
}

export function setError(reason: string): void {
  _state.tokenState = "ERROR";
  _state.lastError  = reason;
  // Redact any token material from the reason string
  _state.lastError  = _state.lastError.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  _state.lastError  = _state.lastError.replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
}

export function setReauthRequired(reason?: string): void {
  _state.accessToken = null;
  _state.tokenState  = "REAUTH_REQUIRED";
  _state.lastError   = reason ?? "Re-authorization required";
}

// ── State queries ──────────────────────────────────────────────────────────────

/** Compute the current lifecycle state (checks expiry in real-time). */
function computeCurrentState(): UpstoxTokenState {
  const { tokenState, accessToken, expiresAt } = _state;

  // If we don't have a token in memory, defer to explicit state
  if (!accessToken) return tokenState;

  // Check real-time expiry
  if (expiresAt != null) {
    const now = Date.now();
    if (now >= expiresAt) return "TOKEN_EXPIRED";
    if (now >= expiresAt - EXPIRY_WARNING_MS) return "TOKEN_EXPIRING";
  }

  // Also consider env-configured tokens (UPSTOX_ANALYTICS_TOKEN) as always CONNECTED
  const envToken = process.env.UPSTOX_ANALYTICS_TOKEN ?? process.env.UPSTOX_ACCESS_TOKEN;
  if (envToken && tokenState === "DISCONNECTED") return "CONNECTED";

  return tokenState;
}

/** Get the server-side access token for API calls. NEVER return this to the browser. */
export function getUpstoxAccessTokenServerOnly(): string | null {
  const currentState = computeCurrentState();
  if (currentState === "TOKEN_EXPIRED" || currentState === "REAUTH_REQUIRED" || currentState === "ERROR") {
    return null;
  }
  // Prefer in-memory OAuth token, then env-configured tokens
  return (
    _state.accessToken ??
    process.env.UPSTOX_ANALYTICS_TOKEN ??
    process.env.UPSTOX_ACCESS_TOKEN ??
    null
  );
}

/** Get the public-safe status for frontend consumption. Contains NO secrets. */
export function getPublicStatus(): UpstoxProviderStatus {
  const currentState = computeCurrentState();

  // If env token is configured and no in-memory state, treat as connected
  const hasEnvToken = !!(process.env.UPSTOX_ANALYTICS_TOKEN ?? process.env.UPSTOX_ACCESS_TOKEN);
  const effectiveState = (currentState === "DISCONNECTED" && hasEnvToken) ? "CONNECTED" : currentState;

  const message = {
    DISCONNECTED:    "Not connected. Use /api/in/providers/upstox/connect to authorize.",
    AUTHORIZING:     "OAuth authorization in progress...",
    CONNECTED:       "Connected and operational.",
    TOKEN_EXPIRING:  "Token expiring soon. Will auto-refresh if possible.",
    TOKEN_EXPIRED:   "Token has expired. Re-authorization required.",
    REAUTH_REQUIRED: _state.lastError ?? "Re-authorization required.",
    ERROR:           _state.lastError ?? "Connection error.",
  }[effectiveState];

  const dataOperational = effectiveState === "CONNECTED" || effectiveState === "TOKEN_EXPIRING";

  return {
    state:          effectiveState,
    expiresAt:      _state.expiresAt,
    connectedAt:    _state.connectedAt,
    message,
    dataOperational,
  };
}

/** Whether Upstox is currently able to serve data requests. */
export function isUpstoxOperational(): boolean {
  const s = computeCurrentState();
  return s === "CONNECTED" || s === "TOKEN_EXPIRING";
}
