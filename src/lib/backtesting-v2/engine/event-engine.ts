/**
 * EventEngine — the central orchestrator of the backtest simulation.
 *
 * Pipeline (per bar)
 * ──────────────────
 *   1. SESSION_OPEN      (first bar of a new IST day)
 *   2. MARKET_EVENT      (clock advances one bar)
 *   3. FEATURE_UPDATE    (indicators re-computed — via strategy hooks)
 *   4. STRATEGY_EVALUATION → strategies return SignalEvents
 *   5. SIGNAL_EVENT      (enqueued by strategies, dispatched here)
 *   6. RISK_CHECK        (RiskManager approves / rejects each signal)
 *   7. ORDER_EVENT       (approved signals → orders, added to OrderBook)
 *   8. EXECUTION         (FillModel tries to fill active orders)
 *   9. FILL_EVENT        (filled orders → portfolio updates)
 *  10. PORTFOLIO_UPDATE  (position events emitted)
 *  11. SESSION_CLOSE     (last bar of IST day — force-close open positions)
 *  12. EXPIRY events     (on expiry day)
 *
 * Anti-lookahead enforcement
 * ──────────────────────────
 * Strategies receive a `StrategyContext` that only exposes candles up to
 * `currentBarIndex`. Any attempt to read future bars throws immediately.
 *
 * The engine does NOT allow order fills on the same bar the signal was
 * generated (for NEXT_BAR_OPEN timing). The `validFromBarIndex` on the
 * OrderEvent enforces this — the ExecutionModel checks it.
 */

import { SimulationClock } from "./clock";
import { EventQueue } from "./event-queue";
import { Portfolio } from "../models/portfolio";
import { OrderBook, orderEventToRecord } from "../models/order";
import type { PortfolioConfig } from "../models/portfolio";
import type { ClockConfig } from "./clock";
import type { OHLCVBar, InstrumentId, MarketEvent } from "../events/market-event";
import { makeEventId } from "../events/market-event";
import type { SignalEvent } from "../events/signal-event";
import type { OrderEvent } from "../events/order-event";
import type { FillEvent } from "../events/fill-event";
import { buildFillEvent } from "../events/fill-event";
import type { RiskCheckEvent } from "../events/risk-event";
import { buildPositionEvent } from "../events/position-event";
import type { AnyEvent } from "../events/index";
import type { CloseReason } from "../models/position";
import { checkIntraBar } from "../models/position";
import type { FillModel } from "../execution/fill-model";
import type { StrategyHandler } from "../adapter/strategy-adapter";
import { nseCommission } from "../execution/commission-model";
import type { RiskManager } from "./risk-manager";

// ── Strategy context — what a strategy can see ───────────────────────────────

export interface StrategyContext {
  /** The bar that just closed (bar N). */
  readonly currentBar: Readonly<OHLCVBar>;
  /** Current bar index. */
  readonly barIndex: number;
  /** Read-only slice of candles [0..barIndex] — NO future access. */
  readonly candles: ReadonlyArray<OHLCVBar>;
  /** Current IST trade date (YYYY-MM-DD). */
  readonly tradeDate: string;
  readonly isSessionOpen: boolean;
  readonly isSessionClose: boolean;
  readonly isExpiryDay: boolean;
  readonly instrument: Readonly<InstrumentId>;
  /** Emit a signal. The engine will route it through risk → order → fill. */
  emit(signal: SignalEvent): void;
}

// ── Engine configuration ──────────────────────────────────────────────────────

export interface EngineConfig {
  portfolioConfig?: Partial<PortfolioConfig>;
  clockConfig?: ClockConfig;
  /** If true, record every event in the queue's log. Disable for performance. */
  logEvents?: boolean;
  /**
   * Maximum drawdown threshold (0..1). Engine halts and marks all positions
   * as closed if this is breached. Default: 0.5 (50%).
   */
  maxDrawdownHalt?: number;
  /** Sector lookup: symbol → sector name for exposure tracking. */
  sectorMap?: Map<string, string>;
}

// ── Run result ────────────────────────────────────────────────────────────────

export interface EngineRunResult {
  portfolio: Portfolio;
  eventLog: ReadonlyArray<AnyEvent>;
  totalBarsProcessed: number;
  haltReason: "COMPLETED" | "MAX_DRAWDOWN" | "DAILY_LOSS_LIMIT" | "ERROR";
  errorMessage?: string;
}

// ── EventEngine ───────────────────────────────────────────────────────────────

export class EventEngine {
  private readonly clock: SimulationClock;
  readonly queue: EventQueue;
  readonly portfolio: Portfolio;
  private readonly orderBook: OrderBook;
  private readonly config: Required<EngineConfig>;

  private _fillModel!: FillModel;
  private _riskManager!: RiskManager;
  private readonly _strategies: StrategyHandler[] = [];

  constructor(config: EngineConfig = {}) {
    this.config = {
      portfolioConfig: config.portfolioConfig ?? {},
      clockConfig: config.clockConfig ?? {},
      logEvents: config.logEvents ?? true,
      maxDrawdownHalt: config.maxDrawdownHalt ?? 0.5,
      sectorMap: config.sectorMap ?? new Map(),
    };

    this.clock = new SimulationClock(this.config.clockConfig);
    this.queue = new EventQueue({ logEnabled: this.config.logEvents });
    this.portfolio = new Portfolio(this.config.portfolioConfig);
    this.orderBook = new OrderBook();

    this._wirePipelineHandlers();
  }

  // ── Dependency injection ─────────────────────────────────────────────────

  setFillModel(model: FillModel): this {
    this._fillModel = model;
    return this;
  }

  setRiskManager(manager: RiskManager): this {
    this._riskManager = manager;
    return this;
  }

  addStrategy(strategy: StrategyHandler): this {
    this._strategies.push(strategy);
    return this;
  }

  // ── Main run loop ─────────────────────────────────────────────────────────

  run(
    bars: OHLCVBar[],
    instrument: InstrumentId,
  ): EngineRunResult {
    if (!this._fillModel) throw new Error("EventEngine: FillModel not set");
    if (!this._riskManager) throw new Error("EventEngine: RiskManager not set");

    this.clock.load(bars, instrument);
    let totalBarsProcessed = 0;
    let haltReason: EngineRunResult["haltReason"] = "COMPLETED";
    let errorMessage: string | undefined;
    let lastTradeDate = "";

    try {
      while (this.clock.hasNext) {
        const tick = this.clock.next();
        if (!tick) break;

        const { event, tradeDate, isNewSession } = tick;

        // Session open bookkeeping
        if (isNewSession) {
          if (lastTradeDate !== "") {
            // Previous session close was already handled at bar end
          }
          this.portfolio.onSessionOpen(event.timestampMs);
          lastTradeDate = tradeDate;

          // Emit SESSION_OPEN
          this.queue.enqueue({
            id: makeEventId("so"),
            type: "SESSION_OPEN",
            timestampMs: event.timestampMs,
            sourceEventId: event.id,
            tradeDate,
          });
          this.queue.flush();
        }

        // ── Bar processing pipeline ──────────────────────────────────────

        // 1. MARKET_EVENT — central event
        this.queue.enqueue(event);
        this.queue.flush();

        // 2. Intra-bar SL/TP check on all open positions
        this._checkOpenPositionsSLTP(event);

        // 3. Expire stale orders
        this.orderBook.expireStale(event.barIndex);
        this.orderBook.activateReady(event.barIndex);

        // 4. STRATEGY_EVALUATION — call each strategy
        this._evaluateStrategies(event);

        // 5. Flush any enqueued signals → risk → orders
        this.queue.flush();

        // 6. Execute active orders against this bar
        this._executeOrders(event);

        // 7. Mark portfolio to market
        const prices = new Map<string, number>([[instrument.symbol, event.bar.close]]);
        this.portfolio.markToMarket(prices);

        // 8. Snapshot equity curve
        this.portfolio.snapshotEquity(event.timestampMs, event.barIndex);

        // 9. Session close: force-close all open positions
        if (event.isSessionClose) {
          this._forceCloseAll(event, "SESSION_CLOSE");
          this.portfolio.onSessionClose(event.timestampMs);
          this.queue.enqueue({
            id: makeEventId("sc"),
            type: "SESSION_CLOSE",
            timestampMs: event.timestampMs,
            sourceEventId: event.id,
            tradeDate,
          });
          this.queue.flush();
        }

        // 10. Expiry forced close
        if (event.isExpiryDay && event.isSessionClose) {
          this.queue.enqueue({
            id: makeEventId("ef"),
            type: "EXPIRY_FORCED_CLOSE",
            timestampMs: event.timestampMs,
            sourceEventId: event.id,
            instrument,
            expiryDate: instrument.expiry ?? tradeDate,
            settlementPrice: event.bar.close,
          });
          this.queue.flush();
        }

        totalBarsProcessed++;

        // Halt checks
        if (this.portfolio.isMaxDrawdownHit(this.config.maxDrawdownHalt)) {
          haltReason = "MAX_DRAWDOWN";
          this._forceCloseAll(event, "PORTFOLIO_BREACH");
          break;
        }
        if (this.portfolio.isDailyLossLimitHit()) {
          haltReason = "DAILY_LOSS_LIMIT";
          break;
        }
      }
    } catch (err) {
      haltReason = "ERROR";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    return {
      portfolio: this.portfolio,
      eventLog: this.queue.eventLog(),
      totalBarsProcessed,
      haltReason,
      errorMessage,
    };
  }

  // ── Pipeline handlers ─────────────────────────────────────────────────────

  private _wirePipelineHandlers(): void {
    // SIGNAL_EVENT → risk check
    this.queue.on<SignalEvent>("SIGNAL_EVENT", (signal) => {
      const riskResult = this._riskManager.check(signal, this.portfolio, this.orderBook);
      this.queue.enqueue(riskResult);
    });

    // RISK_CHECK → ORDER_EVENT (only if approved)
    this.queue.on<RiskCheckEvent>("RISK_CHECK", (risk) => {
      if (risk.decision !== "APPROVED") return;
      // Find the originating signal from the log
      const signal = this.queue
        .eventLog()
        .findLast((e): e is SignalEvent => e.type === "SIGNAL_EVENT" && e.id === risk.signalEventId);
      if (!signal) return;

      const order = this._riskManager.buildOrder(signal, this.portfolio);
      if (order) {
        this.orderBook.add(orderEventToRecord(order));
        this.queue.enqueue(order);
      }
    });
  }

  // ── Strategy evaluation ───────────────────────────────────────────────────

  private _evaluateStrategies(event: MarketEvent): void {
    const ctx: StrategyContext = {
      currentBar: event.bar,
      barIndex: event.barIndex,
      candles: this.clock.candleSlice(event.barIndex),
      tradeDate: this.clock.currentTradeDate(),
      isSessionOpen: event.isSessionOpen,
      isSessionClose: event.isSessionClose,
      isExpiryDay: event.isExpiryDay,
      instrument: event.instrument,
      emit: (signal) => {
        // Validate: signal must reference the current bar, not a future one
        if (signal.signalBarIndex > event.barIndex) {
          throw new Error(
            `Anti-lookahead violation: signal.signalBarIndex (${signal.signalBarIndex}) > currentBarIndex (${event.barIndex})`,
          );
        }
        this.queue.enqueue(signal);
      },
    };

    for (const strategy of this._strategies) {
      try {
        strategy.onBar(ctx);
      } catch (err) {
        // Strategies must not crash the engine — log and continue
        console.warn(`Strategy ${strategy.id} threw on bar ${event.barIndex}:`, err);
      }
    }
  }

  // ── Intra-bar SL/TP checks ────────────────────────────────────────────────

  private _checkOpenPositionsSLTP(event: MarketEvent): void {
    for (const pos of this.portfolio.openPositions()) {
      if (pos.instrument.symbol !== event.instrument.symbol) continue;

      const result = checkIntraBar(pos, event.bar.high, event.bar.low);

      if (result.hit) {
        this._forceClosePosition(pos.id, event, result.exitPrice, result.reason as CloseReason);
      }
    }
  }

  // ── Order execution ───────────────────────────────────────────────────────

  private _executeOrders(event: MarketEvent): void {
    const active = this.orderBook.activeAt(event.barIndex);
    for (const order of active) {
      if (order.instrument.symbol !== event.instrument.symbol) continue;

      const fill = this._fillModel.tryFill(order, event.bar, event.barIndex, event.timestampMs);
      if (!fill) continue;

      order.status = "FILLED";
      order.fillPrice = fill.fillPrice;
      order.filledAtBarIndex = event.barIndex;
      order.fillEventId = fill.id;

      this.queue.enqueue(fill);
      this._applyFill(fill, order.signalEventId, order.orderEventId);
    }
  }

  // ── Fill application ──────────────────────────────────────────────────────

  private _applyFill(fill: FillEvent, signalEventId: string, _orderEventId: string): void {
    // Find the originating signal for attribution
    const signal = this.queue
      .eventLog()
      .findLast((e): e is SignalEvent => e.type === "SIGNAL_EVENT" && e.id === signalEventId);

    if (fill.intent === "OPEN") {
      if (!signal) return;
      const pos = this.portfolio.openPositionFromFill(fill, {
        stopLoss: signal.levels.stopLoss,
        target: signal.levels.target,
        attribution: {
          strategyId: signal.attribution.strategyId,
          signalId: signal.id,
          modelVersion: signal.attribution.modelVersion ?? "",
          featureVersion: signal.attribution.featureVersion ?? "",
          marketRegime: signal.attribution.marketRegime,
          dataQualityScore: signal.attribution.dataQualityScore,
        },
        sectorHint: this.config.sectorMap.get(fill.instrument.symbol),
      });

      this.queue.enqueue(
        buildPositionEvent({
          sourceEventId: fill.sourceEventId,
          timestampMs: fill.timestampMs,
          positionId: pos.id,
          fillEventId: fill.id,
          instrument: pos.instrument,
          direction: pos.direction,
          status: "OPEN",
          qty: pos.qty,
          avgEntryPrice: pos.avgEntryPrice,
          markPrice: fill.fillPrice,
          unrealisedPnl: 0,
          realisedPnl: 0,
          totalCommission: pos.totalCommission,
          openedAtMs: pos.openedAtMs,
          closedAtMs: null,
          openBarIndex: pos.openBarIndex,
          closeBarIndex: null,
          strategyId: pos.attribution.strategyId,
          signalId: pos.attribution.signalId,
          marketRegime: pos.attribution.marketRegime,
          dataQualityScore: pos.attribution.dataQualityScore,
          stopLoss: pos.stopLoss,
          target: pos.target,
        }),
      );
    } else if (fill.intent === "CLOSE" || fill.intent === "STOP_LOSS" || fill.intent === "TAKE_PROFIT") {
      // Find the open position for this symbol
      const pos = this.portfolio.positionForSymbol(fill.instrument.symbol);
      if (!pos) return;

      const reason: CloseReason =
        fill.intent === "STOP_LOSS" ? "STOP" :
        fill.intent === "TAKE_PROFIT" ? "TARGET" :
        "MANUAL";

      const trade = this.portfolio.closePositionFromFill(pos.id, fill, reason);

      this.queue.enqueue(
        buildPositionEvent({
          sourceEventId: fill.sourceEventId,
          timestampMs: fill.timestampMs,
          positionId: pos.id,
          fillEventId: fill.id,
          instrument: pos.instrument,
          direction: pos.direction,
          status: "CLOSED",
          qty: 0,
          avgEntryPrice: pos.avgEntryPrice,
          markPrice: fill.fillPrice,
          unrealisedPnl: 0,
          realisedPnl: trade.netPnl,
          totalCommission: trade.commission,
          openedAtMs: pos.openedAtMs,
          closedAtMs: pos.closedAtMs!,
          openBarIndex: pos.openBarIndex,
          closeBarIndex: pos.closeBarIndex!,
          closeReason: reason,
          strategyId: pos.attribution.strategyId,
          signalId: pos.attribution.signalId,
          marketRegime: pos.attribution.marketRegime,
          dataQualityScore: pos.attribution.dataQualityScore,
          stopLoss: pos.stopLoss,
          target: pos.target,
        }),
      );
    }
  }

  // ── Force close helpers ───────────────────────────────────────────────────

  private _forceClosePosition(
    positionId: string,
    event: MarketEvent,
    exitPrice: number,
    reason: CloseReason,
  ): void {
    const pos = this.portfolio.getPosition(positionId);
    if (!pos) return;

    const fillIntent =
      reason === "STOP" ? "STOP_LOSS" as const :
      reason === "TARGET" ? "TAKE_PROFIT" as const :
      "CLOSE" as const;

    // Build a synthetic fill for force-close
    const commission = nseCommission(exitPrice, pos.qty, pos.instrument.lotSize);

    const fill: FillEvent = buildFillEvent({
      sourceEventId: event.sourceEventId,
      orderEventId: makeEventId("force_ord"),
      signalEventId: pos.attribution.signalId,
      timestampMs: event.timestampMs,
      instrument: pos.instrument,
      side: pos.direction === "LONG" ? "SELL" : "BUY",
      intent: fillIntent,
      direction: pos.direction,
      qty: pos.qty,
      fillPrice: exitPrice,
      commission,
      slippage: 0,
      signalTimestampMs: pos.openedAtMs,
      executionTimestampMs: event.timestampMs,
      executionBarIndex: event.barIndex,
    });

    this.queue.enqueue(fill);
    this._applyFill(fill, pos.attribution.signalId, fill.orderEventId);
  }

  private _forceCloseAll(event: MarketEvent, reason: CloseReason): void {
    const openPositions = this.portfolio.openPositions().slice();
    for (const pos of openPositions) {
      this._forceClosePosition(pos.id, event, event.bar.close, reason);
    }
    this.queue.flush();
  }
}

// ── RiskManager is imported from ./risk-manager.ts ───────────────────────────
// See risk-manager.ts for the interface definition and DefaultRiskManager implementation.
export type { RiskManager };