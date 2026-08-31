/**
 * backtesting-v2 — institutional-grade event-driven backtesting engine
 * for the Indian NSE F&O market.
 *
 * Quick-start
 * ───────────
 *   import { EventEngine, DefaultRiskManager, ExecutionModel, buildPerformanceReport } from "@/lib/backtesting-v2";
 *
 *   const engine = new EventEngine({ portfolioConfig: { initialCapital: 1_000_000 } })
 *     .setFillModel(ExecutionModel.realistic("FO_OPTIONS"))
 *     .setRiskManager(new DefaultRiskManager())
 *     .addStrategy(new IndiaPriceStrategyAdapter(momentumModule));
 *
 *   const result = engine.run(bars, instrument);
 *   const report = buildPerformanceReport({ trades: result.portfolio.closedTrades(), portfolio: result.portfolio, totalBarsProcessed: result.totalBarsProcessed });
 */

// Events
export * from "./events/index";

// Models
export * from "./models/index";

// Engine
export * from "./engine/index";

// Execution
export * from "./execution/index";

// Analytics
export * from "./analytics/index";

// Adapters
export * from "./adapter/index";
