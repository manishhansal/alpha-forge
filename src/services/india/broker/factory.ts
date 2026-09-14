/**
 * src/services/india/broker/factory.ts
 *
 * Execution-only broker factory for Indian market order placement.
 *
 * After the data-service2.0 centralization, this factory ONLY handles
 * order execution brokers. Market data comes exclusively from data-service2.0.
 *
 * Supported execution backends:
 *   - openalgo  (OpenAlgo REST API — any compatible broker)
 *
 * NOTE: Yahoo, Groww, NSE and any other market-data-only adapters have been
 * removed. Angel One is kept only for portfolio/account data (see angelone/).
 * Market data must NEVER be requested through a broker adapter.
 */
import { OpenAlgoAdapter } from "./openalgo-adapter";

/**
 * Returns an OpenAlgo execution adapter when configured.
 * Returns null when OPENALGO_BASE_URL or OPENALGO_API_KEY are not set.
 */
export function getOpenAlgoAdapter(): OpenAlgoAdapter | null {
  const baseUrl = process.env.OPENALGO_BASE_URL;
  const apiKey = process.env.OPENALGO_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new OpenAlgoAdapter(baseUrl, apiKey);
}

/**
 * Returns the active execution adapter or throws if none is configured.
 * Valid INDIA_BROKER values: openalgo
 */
export function getExecutionBroker(): OpenAlgoAdapter {
  const adapter = getOpenAlgoAdapter();
  if (!adapter) {
    throw new Error(
      "No execution broker configured. Set OPENALGO_BASE_URL and OPENALGO_API_KEY " +
      "to enable live order execution.",
    );
  }
  return adapter;
}

/**
 * @deprecated Use getExecutionBroker() for order execution.
 * Market data now comes from data-service2.0, not from broker adapters.
 */
export function getBroker(): OpenAlgoAdapter {
  return getExecutionBroker();
}

/**
 * @deprecated Option chains are now fetched via data-service2.0.
 * This function is retained only for backward compatibility during migration
 * and will be removed in the next cleanup phase.
 */
export function getOptionChainBroker(): null {
  console.warn(
    "[DEPRECATED] getOptionChainBroker() — option chains must be fetched via " +
    "DataServiceClient.market.options() from data-service2.0.",
  );
  return null;
}

/**
 * @deprecated Broker-by-id lookup is no longer supported.
 * Use getExecutionBroker() for execution, DataServiceClient for market data.
 */
export function getBrokerById(_id: string): null {
  return null;
}
