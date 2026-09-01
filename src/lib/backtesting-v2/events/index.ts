/**
 * Barrel re-export for the events layer.
 * Import everything from here to avoid reaching into sub-modules.
 */

export * from "./market-event";
export * from "./signal-event";
export * from "./order-event";
export * from "./fill-event";
export * from "./position-event";
export * from "./risk-event";

import type { MarketEvent, SessionOpenEvent, SessionCloseEvent, ExpiryWarningEvent, ExpiryForcedCloseEvent } from "./market-event";
import type { SignalEvent } from "./signal-event";
import type { OrderEvent } from "./order-event";
import type { FillEvent } from "./fill-event";
import type { PositionEvent } from "./position-event";
import type { RiskCheckEvent, RiskBreachEvent } from "./risk-event";

/** Discriminated union of ALL events the engine can emit. */
export type AnyEvent =
  | MarketEvent
  | SessionOpenEvent
  | SessionCloseEvent
  | ExpiryWarningEvent
  | ExpiryForcedCloseEvent
  | SignalEvent
  | OrderEvent
  | FillEvent
  | PositionEvent
  | RiskCheckEvent
  | RiskBreachEvent;
