/**
 * Scraping tick listener — NO-OP STUB
 *
 * Phase 3 of the data-service2.0 centralization refactor.
 *
 * This file previously subscribed to `af:ticks:*` Redis pub/sub channels
 * published by the legacy Python data-service Scrapling tick publisher.
 *
 * Tick listening is now handled entirely by data-service2.0. The worker
 * no longer connects directly to the Scrapling Redis pub/sub. Live ticks
 * from data-service2.0 are delivered via the DataServiceClient WebSocket
 * subscription (see `src/lib/data-service/client.ts` → `subscribeToTicks`).
 *
 * These stub exports are retained so that any existing callers compile
 * without changes. Both functions are no-ops and log a single info message.
 */

import { createLogger } from "../log";

const log = createLogger("worker:scraping-tick-listener");

/**
 * No-op. Tick listening is now handled by data-service2.0.
 *
 * @deprecated Use `subscribeToTicks` from `@/lib/data-service/client` instead.
 */
export function startScrapingTickListener(
   
  _onTick: (tick: unknown) => void,
): void {
  log.info(
    "scraping tick listener is a no-op — " +
      "tick listening is now handled by data-service2.0. " +
      "Use DataServiceClient.subscribeToTicks() for live ticks.",
  );
}

/**
 * No-op. Nothing to stop.
 *
 * @deprecated Use `subscribeToTicks` from `@/lib/data-service/client` instead.
 */
export function stopScrapingTickListener(): void {
  log.info("scraping tick listener stop called (no-op).");
}
