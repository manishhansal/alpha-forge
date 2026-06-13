"use client";

import { useBinanceTickers } from "@/hooks/useBinanceTickers";
import { useActiveMarket } from "@/lib/market-mode";

function CryptoStream() {
  useBinanceTickers();
  return null;
}

/**
 * Owns the long-lived live-data subscriptions for the active market. The
 * crypto WebSocket is heavy (per-symbol streams + reconnect logic), so we
 * only connect it when the user is actually inside the crypto surface — the
 * Indian-market ticker bar polls its own SSE/snapshot endpoints and doesn't
 * need this mount.
 */
export function LiveStreamMount() {
  const market = useActiveMarket();
  if (market === "crypto") return <CryptoStream />;
  return null;
}
