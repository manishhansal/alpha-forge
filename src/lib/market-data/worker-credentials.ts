/**
 * worker-credentials.ts — Data Foundation V5 (§4/§5/§71/§72).
 *
 * THE V5 ROOT-CAUSE FIX. Broker credentials are stored per-user in the DB
 * (`UserSetting.apiKeysEncrypted`, entered via the frontend Data Sources UI),
 * but the request-scoped resolvers (`getAngelConfigForRequest` /
 * `getUpstoxTokenForRequest`) call `auth()`, which returns null in the worker
 * (no session cookie). So the worker/backfill could never use the stored broker
 * credentials and silently fell back to Yahoo — leaving intraday = 0.
 *
 * This module provides a PROCESS-SCOPED credential override that the worker (or
 * any non-request runtime: backfill scripts, self-test, readiness) populates at
 * startup by resolving the owning user's credentials DIRECTLY by userId — no
 * session required. The Angel + Upstox provider clients consult this override
 * BEFORE the env/session paths, so a credentialed provider becomes usable in the
 * worker context.
 *
 * SECURITY (§74): credentials live only in this process's memory, are never
 * logged, and are never returned to the browser. The override is set only by
 * trusted server/worker code, never from a request handler.
 */

// Deliberately NO `import "server-only"` — this module is loaded by the worker
// and by CLI scripts that run outside the Next.js server runtime.

export interface WorkerAngelCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

interface Override {
  angel: WorkerAngelCredentials | null;
  upstoxAnalyticsToken: string | null;
  /** The userId these came from (for diagnostics; never a secret). */
  sourceUserId: string | null;
  loadedAt: number | null;
}

declare global {
  var __afWorkerCredentials: Override | undefined; // eslint-disable-line no-var
}

const state: Override =
  globalThis.__afWorkerCredentials ?? {
    angel: null,
    upstoxAnalyticsToken: null,
    sourceUserId: null,
    loadedAt: null,
  };
if (!globalThis.__afWorkerCredentials) globalThis.__afWorkerCredentials = state;

/** Set the process-scoped Angel One credentials (worker startup only). */
export function setWorkerAngelCredentials(
  creds: WorkerAngelCredentials | null,
  sourceUserId?: string,
): void {
  state.angel = creds;
  if (sourceUserId) state.sourceUserId = sourceUserId;
  state.loadedAt = Date.now();
}

/** Set the process-scoped Upstox analytics token (worker startup only). */
export function setWorkerUpstoxToken(token: string | null, sourceUserId?: string): void {
  state.upstoxAnalyticsToken = token;
  if (sourceUserId) state.sourceUserId = sourceUserId;
  state.loadedAt = Date.now();
}

/** Angel One credentials from the process override, or null. */
export function getWorkerAngelCredentials(): WorkerAngelCredentials | null {
  return state.angel;
}

/** Upstox analytics token from the process override, or null. */
export function getWorkerUpstoxToken(): string | null {
  return state.upstoxAnalyticsToken;
}

/** Non-secret diagnostics for reports/health. */
export function workerCredentialStatus(): {
  angelLoaded: boolean;
  upstoxLoaded: boolean;
  sourceUserId: string | null;
  loadedAt: string | null;
} {
  return {
    angelLoaded: state.angel !== null,
    upstoxLoaded: state.upstoxAnalyticsToken !== null,
    sourceUserId: state.sourceUserId ? state.sourceUserId.slice(0, 6) + "…" : null,
    loadedAt: state.loadedAt ? new Date(state.loadedAt).toISOString() : null,
  };
}

/**
 * Load broker credentials from the DB by resolving the owning user WITHOUT a
 * session, and populate the process override. Intended for worker startup and
 * CLI scripts. Returns a non-secret summary of what was loaded.
 *
 * Resolution: if `userId` is given, use it; otherwise pick the single user that
 * has stored api keys (typical single-operator deployment). Multi-user
 * deployments should pass an explicit `userId` (e.g. a designated data account).
 */
export async function loadWorkerCredentialsFromDb(opts?: {
  userId?: string;
  prisma?: import("@prisma/client").PrismaClient;
}): Promise<{ angel: boolean; upstox: boolean; userId: string | null; reason?: string }> {
  const { getPrisma } = await import("@/lib/prisma");
  const prisma = opts?.prisma ?? getPrisma();

  let userId = opts?.userId ?? null;
  if (!userId) {
    // Find the user(s) with stored api keys. Prefer a single unambiguous owner.
    const settings = await prisma.userSetting.findMany({
      select: { userId: true, apiKeysEncrypted: true },
    });
    const withKeys = settings.filter(
      (s) => s.apiKeysEncrypted && typeof s.apiKeysEncrypted === "object",
    );
    if (withKeys.length === 0) {
      return { angel: false, upstox: false, userId: null, reason: "no_stored_credentials" };
    }
    if (withKeys.length > 1) {
      // Ambiguous — do not guess. Caller must pass an explicit userId.
      return {
        angel: false,
        upstox: false,
        userId: null,
        reason: `ambiguous_multiple_users_with_keys:${withKeys.length}`,
      };
    }
    userId = withKeys[0]!.userId;
  }

  const { readAngelCredentials, readUpstoxCredentials } = await import(
    "@/features/settings/api-keys"
  );

  let angelLoaded = false;
  let upstoxLoaded = false;
  try {
    const angel = await readAngelCredentials(userId);
    if (angel) {
      setWorkerAngelCredentials(angel, userId);
      angelLoaded = true;
    }
  } catch {
    /* decryption failure — leave unset, reported via status */
  }
  try {
    const up = await readUpstoxCredentials(userId);
    if (up?.analyticsToken) {
      setWorkerUpstoxToken(up.analyticsToken, userId);
      upstoxLoaded = true;
    }
  } catch {
    /* leave unset */
  }

  return { angel: angelLoaded, upstox: upstoxLoaded, userId };
}
