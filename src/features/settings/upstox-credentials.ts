// NOTE: Do NOT add `import "server-only"` here. This module is lazily
// imported by the Upstox provider's resolveReadToken(), which runs in both
// the Next.js request context AND the background worker context. The
// `server-only` guard throws at module load time in non-Next.js environments,
// which would crash the worker process for any deployment that relies on
// per-user DB Upstox credentials without an env-var token.
//
// Security is preserved: the function returns null outside a request context
// (auth() returns null when no session cookie is present) and the token is
// used server-side only, never forwarded to the client.

import { auth } from "@/lib/auth";

import { readUpstoxCredentials, type UpstoxStoredCredentials } from "./api-keys";

/**
 * Request-scoped Upstox credential resolver.
 *
 * Loaded lazily by the Upstox provider (`resolveReadToken`) only when none
 * of the three environment-variable token sources (UPSTOX_ANALYTICS_TOKEN,
 * in-memory OAuth token, UPSTOX_ACCESS_TOKEN) are present. Reads the
 * signed-in user's encrypted Analytics Token and returns it decrypted.
 *
 * Returns `null` for:
 *   - Anonymous/unauthenticated requests (auth() returns null)
 *   - Worker context (no session cookie present)
 *   - Any request where no Upstox key is stored for the user
 *
 * When null is returned the provider silently falls over to Yahoo Finance.
 * Never returns the token to the client.
 */
export async function getUpstoxTokenForRequest(): Promise<UpstoxStoredCredentials | null> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    return await readUpstoxCredentials(userId);
  } catch {
    return null;
  }
}
