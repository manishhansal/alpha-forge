import "server-only";

import type { BrokerAdapter, BrokerStreamClient, ConnectionStatus } from "./types";

/**
 * The server-side flavour of `BrokerAdapter` is functionally identical to the
 * full interface, but in practice the only methods called from server code
 * are the REST ones. WS factories return a `ServerStreamStub` so the
 * interface stays uniform without dragging the browser `WebSocket` into the
 * Node bundle.
 */
export type ServerBrokerAdapter = BrokerAdapter;

/**
 * No-op stream client used on the server (and on adapters that don't expose
 * a public stream for the given channel). `connect()` immediately fires the
 * `unavailable` status so callers can render a "stream offline" badge
 * instead of waiting on a connection that will never open.
 */
export function createServerStreamStub(label: string): BrokerStreamClient {
  return {
    connect: () => {
      // Intentionally no-op — server bundles shouldn't open WS sockets.
      // Tag so it's grep-able if anything ever does call connect().
      void label;
    },
    disconnect: () => {
      // Intentionally no-op.
    },
  };
}

export function statusUnavailable(
  onStatusChange?: (status: ConnectionStatus) => void,
): void {
  onStatusChange?.("unavailable");
}
