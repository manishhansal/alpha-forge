import "server-only";

import { auth } from "@/lib/auth";
import type { AngelCredentials } from "@/services/india/angelone";

import { readAngelCredentials } from "./api-keys";

/**
 * Request-scoped Angel One credential resolver.
 *
 * Loaded lazily by the Angel One adapter (`resolveConfig`) only when the
 * environment doesn't already carry SmartAPI credentials. Reads the signed-in
 * user's encrypted Angel One key (entered via Profile → API keys) and returns
 * the decrypted credential set. Returns `null` for anonymous requests or when
 * no (complete) Angel One key is stored, so the adapter falls back to
 * Yahoo / NSE.
 *
 * Never returns these values to the client — the caller uses them server-side
 * to sign a SmartAPI login and discards them.
 */
export async function getAngelConfigForRequest(): Promise<AngelCredentials | null> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    return await readAngelCredentials(userId);
  } catch {
    return null;
  }
}
