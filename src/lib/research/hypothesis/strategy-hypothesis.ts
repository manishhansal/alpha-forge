/**
 * Phase 2 — Strategy Hypothesis Framework
 *
 * Every strategy must explicitly declare its market hypothesis before it can
 * be promoted past EXPERIMENTAL.  A strategy with no declared hypothesis is
 * automatically marked UNVALIDATED and cannot advance to BACKTEST_VALIDATED.
 *
 * Hypotheses are code — they must be peer-reviewed and version-controlled.
 * A hypothesis version change resets the validation clock.
 */

import type { StrategyHypothesis, MarketRegime } from "../types";

// ─── Hypothesis Catalog ───────────────────────────────────────────────────────

const HYPOTHESIS_CATALOG: StrategyHypothesis[] = [
  {
    strategyId: "UT_SMC",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When the ATR trailing stop flips direction AND price is breaking a structural pivot (BOS/CHoCH per Smart Money Concepts), the probability of follow-through in the flip direction over the next 5–60 minutes is above chance because the dual confirmation filters out noise-driven trail flips that occur in congestion zones.",
    marketInefficiency:
      "Retail stop-hunting around equal highs/lows creates predictable momentum bursts after structure breaks. Market-makers engineer liquidity sweeps before continuation moves, leaving a technical footprint that the UT Bot trailing stop can detect.",
    expectedEdge:
      "Higher win-rate and R:R than a pure UT Bot signal by requiring structural context. Expected Sharpe > 0.8 OOS on crypto perpetuals (5m timeframe) in trending regimes.",
    expectedFailureMode:
      "Choppy sideways markets generate false BOS signals. Low-liquidity hours produce wide ATR stops that make the R:R unattractive. High-correlation periods (all cryptos moving together) reduce diversification benefit.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "5–60 minutes",
    whyEdgeShouldExist:
      "SMC structure identifies where institutional order flow has defended price. Combining with the ATR trail provides a mechanical entry that captures the post-sweep continuation. The edge is structural, not statistical artefact.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.4 after full transaction costs over ≥200 trades. Parameter sensitivity: if Sharpe collapses when keyValue changes from 1→0.8 or 1→1.2, the strategy is overfit. If win-rate drops below 40% in trending regimes, the structural hypothesis is refuted.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "VWAP_SWEEP_TREND",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When price sweeps a prior swing high/low (taking out stops) while significantly stretched from VWAP AND the higher-timeframe trend is intact, the subsequent mean-reversion back to VWAP has elevated probability because the sweep is a stop-hunt by informed traders who then fade the imbalance.",
    marketInefficiency:
      "VWAP acts as a fair-value anchor for institutional participants. Extreme deviations are statistically unlikely to persist intraday. Liquidity sweeps concentrate stop orders, creating a predictable snap-back after the sweep completes.",
    expectedEdge:
      "Mean reversion from VWAP extremes with trend confirmation. Expected win-rate ~55-60% with 1:1 R:R; Sharpe > 0.7 OOS.",
    expectedFailureMode:
      "Trending sessions where VWAP is continuously left behind — reversion entries become trend fade against momentum. Earnings/macro events that sustain the deviation permanently.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "NORMAL_DAY"],
    expectedHoldingPeriod: "10–90 minutes",
    whyEdgeShouldExist:
      "Institutional VWAP benchmarking creates predictable order flow around fair value. The sweep-and-reversal pattern has been documented in market microstructure literature as indicative of informed trader absorption.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.4. Win-rate below 45%. Average win < 0.8× average loss (R:R breaks). If performance is not materially better in trending vs range regimes, the trend filter provides no value.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "NEWS_MOMENTUM",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "Explosive moves characterised by volume ≥2.8× average AND range ≥1.8×ATR represent information-driven dislocations (exchange listings, protocol upgrades, liquidation cascades, macro prints). These moves exhibit short-term momentum continuation as the information diffuses through the market.",
    marketInefficiency:
      "Information diffusion in crypto is non-instantaneous. Early participants who obtain/interpret news first push price; late market participants catching up provide the continuation momentum. This is the classic information cascade.",
    expectedEdge:
      "Short-term momentum continuation of 15–30 minutes after the impulse. Expected win-rate ~50% but with positive expectancy via 1.5:1 R:R.",
    expectedFailureMode:
      "Mean-reversion after the impulse when the news is already fully priced. Trading the tail-end of the move results in chasing. High slippage in illiquid conditions makes the edge disappear after costs.",
    expectedRegime: ["HIGH_VOLATILITY", "EVENT_DRIVEN"],
    expectedHoldingPeriod: "5–30 minutes",
    whyEdgeShouldExist:
      "Short-term post-news momentum has been consistently documented across equity and crypto markets. The mechanical filter (volume + range) isolates genuine information events from random noise.",
    whatWouldInvalidate:
      "Net expectancy ≤ 0 after 2× slippage stress-test. Win-rate below 45% in event-regime attribution. Strategy becomes COST_FRAGILE at 1.5× costs.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "RANGE_SCALP",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When Bollinger Band width is compressed (≤4.5×ATR), price repeatedly oscillates between the upper and lower bands. An RSI extreme at the band edge followed by a close back inside represents exhaustion of the short-term directional move, providing a mean-reversion entry to the midband.",
    marketInefficiency:
      "In range-bound markets, liquidity-providing market-makers systematically buy lows and sell highs of the range. This creates a mean-reverting micro-structure that technical systems can participate in.",
    expectedEdge:
      "High win-rate (>60%) in range-bound regimes with consistent small profits. Expected Sharpe > 1.0 in RANGE_BOUND regime attribution. Must fail/degrade clearly in trending regimes.",
    expectedFailureMode:
      "Breakout from the range after accumulation — the strategy takes losses as it fades the breakout bar. High-vol events expand Bollinger Bands, invalidating the range assumption. The flat-midband filter is crucial to avoid this.",
    expectedRegime: ["RANGE_BOUND", "LOW_VOLATILITY"],
    expectedHoldingPeriod: "10–60 minutes",
    whyEdgeShouldExist:
      "Range-bound market microstructure is well-documented. BB squeeze → mean-reversion is a classic statistical phenomenon backed by decades of quant literature.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.5 in RANGE_BOUND regime. Win-rate below 55%. If the strategy is profitable in BULL_TRENDING regime (it should NOT be), the range filter is broken.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "EMA_PULLBACK",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "In a confirmed uptrend (EMA9 > EMA20 > EMA50 with rising slopes), brief pullbacks into the EMA9-20 zone represent temporary supply/demand imbalances. The trend's underlying momentum reasserts when a confirmation candle closes above EMA9, producing a continuation move.",
    marketInefficiency:
      "Moving average clusters act as dynamic support/resistance because of the widespread use of these indicators by institutional systems, creating self-fulfilling order clustering.",
    expectedEdge:
      "Trend-continuation win-rate ~55% with 2:1 R:R minimum. Expected Sharpe > 0.9 in BULL_TRENDING regime. Must degrade in RANGE_BOUND.",
    expectedFailureMode:
      "EMA stacks maintain bull configuration for bars after the underlying trend reverses — the strategy takes losses in the early stages of a reversal. Choppy markets produce many false EMA9 recapture signals.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "15–120 minutes",
    whyEdgeShouldExist:
      "EMA pullback is one of the most statistically robust patterns in technical analysis across multiple asset classes, documented in academic literature and practitioner research.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.5. Payoff ratio below 1.5. If performance in RANGE_BOUND is comparable to BULL_TRENDING, the trend filter is ineffective.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "VWAP_REVERSION",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When price is ≥1.5×ATR from VWAP AND RSI is at an extreme (≤30 or ≥70) with momentum weakening (current bar less extreme than prior), the probability of mean-reversion to VWAP increases because institutional VWAP benchmarking creates systematic buying/selling pressure when deviations are large.",
    marketInefficiency:
      "Same as VWAP_SWEEP_TREND. VWAP benchmarking by large institutions creates a gravitational pull. Pure statistical mean-reversion to the session's volume-weighted fair value.",
    expectedEdge:
      "High win-rate (~65%) at the cost of modest R:R. Expected Sharpe > 1.0 in normal market conditions. Should generate more consistent smaller wins than directional strategies.",
    expectedFailureMode:
      "Strongly trending sessions where VWAP is continuously re-established at higher/lower prices. The strategy keeps fading the trend and accumulates losses.",
    expectedRegime: ["RANGE_BOUND", "NORMAL_DAY", "HIGH_LIQUIDITY"],
    expectedHoldingPeriod: "5–45 minutes",
    whyEdgeShouldExist:
      "VWAP mean-reversion is one of the best-documented intraday statistical patterns. The RSI momentum exhaustion filter adds conviction that the deviation is at its peak.",
    whatWouldInvalidate:
      "Win-rate drops below 55% OOS. Sharpe < 0.5. If performance is worse in RANGE_BOUND than BULL_TRENDING, the strategy is not doing mean-reversion.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "ORDERFLOW_SWEEP",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "Equal highs/lows represent clustered stop orders. When a high-volume wick sweeps these levels and immediately reverses, it indicates a stop-hunt followed by order-flow reversal by a large actor. The subsequent directional move is predictable and measurable.",
    marketInefficiency:
      "Stop-order clustering at obvious technical levels is exploitable because market makers and prop desks routinely engineer these sweeps to fill their own orders at better prices. The stop-hunt pattern is structurally reproducible.",
    expectedEdge:
      "Post-sweep momentum reversal with expected Sharpe > 0.8 OOS. Win-rate ~55-60%. The volume filter (≥1.8×avg) is critical to distinguish genuine sweeps from random wicks.",
    expectedFailureMode:
      "False sweeps: genuine breakouts that look like sweeps but continue in the original breakout direction. Low-liquidity periods where random wicks pass the filter due to thin books.",
    expectedRegime: ["HIGH_LIQUIDITY", "NORMAL_DAY", "BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "5–30 minutes",
    whyEdgeShouldExist:
      "Stop-hunt mechanics are well-documented in market microstructure research. Equal highs/lows as liquidity targets is a central concept in institutional order-flow analysis.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.4. Win-rate below 45%. If removing the volume filter does not change performance, the filter adds no value.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "FIB_PULLBACK",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "After a strong impulse (≥3×ATR), the most probable retracement level for continuation entries is the 0.5-0.618 Fibonacci zone. This zone represents the mathematically natural balance between the impulse and the retracement, and is widely watched by institutional participants, creating a self-fulfilling cluster of limit orders.",
    marketInefficiency:
      "Fibonacci retracement levels create coordinated limit order placement by many participants, creating genuine order-flow clusters at the 0.5 and 0.618 levels. This is a self-fulfilling but real market inefficiency.",
    expectedEdge:
      "Continuation trades at the 0.5-0.618 Fib zone with 1:1 R:R minimum. Expected win-rate ~55%. Must be tested on 1m timeframe only due to design constraints.",
    expectedFailureMode:
      "Deep pullbacks that exceed the 0.786 level invalidate the impulse structure — the strategy should not trade these. The 1m timeframe means high noise sensitivity; individual trade quality is low.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "1–15 minutes",
    whyEdgeShouldExist:
      "Fibonacci retracement levels have consistent empirical support as areas of order-flow concentration across assets and timeframes, with multiple academic studies confirming above-chance hit rates.",
    whatWouldInvalidate:
      "Win-rate below 50% OOS. Expectancy ≤ 0 after costs. If 0.786 retracement occurs too often (strategy filters it out), the impulse identification is too aggressive.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INSTITUTIONAL_SMC",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When 7 of 9 SMC-institutional confluence components align simultaneously AND the four critical preconditions (trend + VWAP position + recent liquidity sweep + recent BOS) are all satisfied, the probability of a high-quality institutional-backed directional move is materially higher than with fewer confirming factors.",
    marketInefficiency:
      "Institutional order flow leaves a traceable footprint across multiple indicators simultaneously. A high-confluence setup signals that multiple independent sources of institutional activity are aligned, reducing the probability of a false signal.",
    expectedEdge:
      "Higher-conviction setups with fewer, better-quality signals. Expected Sharpe > 1.2 OOS due to stringent entry filter. Lower trade frequency is acceptable given higher per-trade quality.",
    expectedFailureMode:
      "Over-filtering: the strategy misses most of the move waiting for 7/9 confluence. Rare signals with insufficient statistical sample size for robust evaluation.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "HIGH_LIQUIDITY"],
    expectedHoldingPeriod: "15–120 minutes",
    whyEdgeShouldExist:
      "Multi-factor institutional confluence reduces false positives. The combination of stop-hunt + structure break + VWAP + volume is more information-rich than any single signal.",
    whatWouldInvalidate:
      "Trade count below 50 per year (insufficient evidence). OOS Sharpe < 0.6. If ablation shows that removing any 3 of the 9 components does not materially change Sharpe, the high confluence bar is unnecessary.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "AI_INSTITUTIONAL_PRO",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "The two-stage gate (hard conditions → confluence score → mode preset) produces higher-quality entries than single-stage filters by ensuring that no trade is taken when fundamental trend context (HTF EMA bias) is misaligned, even if the lower-timeframe confluence score is high.",
    marketInefficiency:
      "Lower-timeframe signals are routinely invalidated by higher-timeframe context. The HTF gate prevents the strategy from fighting the dominant institutional trend.",
    expectedEdge:
      "Mode-adaptive performance: scalp mode on 1m/5m, intraday on 15m. Each mode should show positive OOS Sharpe in its target regime. Cooldown prevents over-trading.",
    expectedFailureMode:
      "The mode preset thresholds are rigid — a market shift can render the calibrated thresholds suboptimal without being detectable until after losses. The cooldown mechanism can cause the strategy to miss valid follow-through trades.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "NORMAL_DAY"],
    expectedHoldingPeriod: "5–90 minutes",
    whyEdgeShouldExist:
      "Multi-timeframe analysis is a foundational quant principle. By requiring HTF agreement, the strategy avoids the single largest source of false positives in pure lower-timeframe systems.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.5 on 5m timeframe. If removing the HTF gate improves OOS Sharpe (it should not), the gate is a net negative. If scalp and intraday modes both underperform, the mode-adaptive concept is flawed.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "FNO_TREND",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When all 14 Chartink trend conditions pass simultaneously (EMA/SMA bull stack, ADX > 20, DI+ > DI−, RSI > 50, MACD bullish, above-average volume, bullish close), the stock is in a strong institutional accumulation phase with elevated probability of continuation over 1–5 trading days.",
    marketInefficiency:
      "Indian F&O stocks with institutional accumulation exhibit momentum persistence due to gradual position-building by large participants who cannot enter all at once. The 14-condition filter captures the most advanced stage of this accumulation.",
    expectedEdge:
      "Multi-day trend continuation. Expected Sharpe > 0.8 OOS on NSE F&O universe. Valid only in BULL_TRENDING regime.",
    expectedFailureMode:
      "All conditions passing near market tops — the strategy enters just before reversal. NSE OHLCV data from Yahoo has survivorship bias; historical results may overstate performance.",
    expectedRegime: ["BULL_TRENDING"],
    expectedHoldingPeriod: "1–5 trading days",
    whyEdgeShouldExist:
      "Multi-condition trend confirmation reduces false entries. Indian equity markets show strong trend persistence during institutional buying phases, particularly in F&O stocks where derivatives activity amplifies trends.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.5. Max drawdown > 20%. Ablation: if removing any 5 of the 14 conditions improves OOS Sharpe, the full 14-condition filter is over-specified.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "FNO_RANGE_EXPANSION",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When an NSE F&O stock breaks out with the widest daily range of the last 8 sessions, a bullish candle body, above-average volume, and a bull SMA stack — all in a week-and-month uptrend — this represents a genuine accumulation breakout rather than noise, with elevated follow-through probability.",
    marketInefficiency:
      "Range expansion breakouts in F&O stocks after consolidation attract momentum following from institutional algos programmed to chase breakouts above defined range thresholds. This creates a predictable demand surge.",
    expectedEdge:
      "2–10 day trend continuation after breakout. Expected Sharpe > 0.7 OOS.",
    expectedFailureMode:
      "Failed breakouts (bull traps): range expansion followed by immediate reversal. High-IV environments where range expands due to volatility rather than directional conviction.",
    expectedRegime: ["BULL_TRENDING", "HIGH_VOLATILITY"],
    expectedHoldingPeriod: "2–10 trading days",
    whyEdgeShouldExist:
      "Volume-confirmed range expansion is one of the most statistically validated breakout patterns across global equity markets.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.4. Win-rate below 45%. Failed breakout rate > 50% (price closes back below breakout level within 2 days more than half the time).",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_AI_SIGNALS",
    hypothesisVersion: "2.0.0",
    hypothesis:
      "A 14-factor weighted confluence model aggregating intraday demand, breakout quality, market regime, derivatives data (PCR, ATM IV, OI build-up, max-pain), news flow, and ML model outputs produces F&O trading signals with meaningful predictive value that exceeds any individual factor alone. The minimum 0.22 magnitude threshold ensures only genuinely directional setups are traded.",
    marketInefficiency:
      "Indian F&O markets exhibit structural inefficiencies at the intersection of options positioning (max-pain, PCR), institutional order flow (OI build-up), and technical breakouts. No single data source captures the full picture — multi-factor confluence reduces false signals by requiring agreement across orthogonal information sources.",
    expectedEdge:
      "Grade S/A signals should produce calibrated win probabilities (47-78% depending on score). Expected Sharpe > 1.0 OOS in SHADOW/PAPER. Cost-adjusted expectancy must be positive.",
    expectedFailureMode:
      "Factor crowding: during regime shifts, many factors move together (all bearish) creating false confidence in the confluence score. The model was calibrated on one market regime and may not generalise. ML component drift after model retrain.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "NORMAL_DAY", "EXPIRY_DAY"],
    expectedHoldingPeriod: "Intraday (4h) to swing (3d)",
    whyEdgeShouldExist:
      "The combination of proprietary first-party options data (PCR, OI) with ML regime classification and quantitative pre-filters is more information-rich than publicly available signals. The edge comes from data advantage, not curve-fitting.",
    whatWouldInvalidate:
      "ECE (Expected Calibration Error) > 0.10 on OOS sample (signals are miscalibrated). OOS Sharpe < 0.5. Paper performance materially worse than shadow (indicates execution issues, not signal issues). Grade D signals consistently outperform Grade S signals (calibration is inverted).",
    status: "DEFINED",
    definedAt: "2024-06-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_SUPER_CONFLUENCE",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When all four independent trend indicators (UT Bot ATR trail, AI Neural Trend Line, SMC BOS structure, EMA 9/15/21 stack) simultaneously confirm the same direction on NSE F&O, the probability of a 15-120 minute continuation move is elevated relative to any single indicator.",
    marketInefficiency:
      "Indian F&O intraday trends are driven by institutional order flow that manifests across multiple technical dimensions simultaneously. A 4/4 confluence is unlikely to occur by chance and represents genuine multi-dimension trend confirmation.",
    expectedEdge:
      "Higher win-rate at 4/4 confluence vs 3/4 vs 2/4. Expected Sharpe > 0.9 OOS at ±0.75 or ±1.0 score threshold.",
    expectedFailureMode:
      "Gap opens and rapid intraday reversals that flip all four indicators within a few bars — entering on the initial 4/4 setup catches the reversal. Components are correlated (all four are trend-following), so the 4/4 may not represent truly independent evidence.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "15–120 minutes",
    whyEdgeShouldExist:
      "Multi-indicator confluence reduces false positives. The four components use different calculation methods (ATR trail, HMA smoothing, pivot structure, EMA stack) that are partially independent.",
    whatWouldInvalidate:
      "3/4 and 4/4 threshold have same OOS Sharpe (super-confluence adds no value over standard confluence). Ablation: if any single component removed does not degrade OOS Sharpe, it is redundant.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_MOMENTUM",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "Near-month F&O futures with the highest absolute % moves on a given day exhibit intraday momentum continuation, driven by delta-hedging flows, derivative-amplified position adjustments, and trend-following algorithms chasing the move.",
    marketInefficiency:
      "F&O delta-hedging creates amplified price movements that exhibit short-term momentum. The near-month futures scanner captures active institutional interest.",
    expectedEdge:
      "Intraday momentum continuation. Expected win-rate ~52-55% with positive expectancy after accounting for higher transaction costs in momentum strategies.",
    expectedFailureMode:
      "Mean-reversion after the initial spike, particularly near end of day. High-volatility events create initial momentum but immediate reversal after the spike completes.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "HIGH_VOLATILITY"],
    expectedHoldingPeriod: "Intraday",
    whyEdgeShouldExist:
      "Intraday momentum in individual stocks has been consistently documented in equity market microstructure research across multiple markets including India.",
    whatWouldInvalidate:
      "Net expectancy ≤ 0 after 2× cost stress. Win-rate below 48%.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_VOLUME_BREAKOUT",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "When an NSE F&O stock's daily volume exceeds 1.5× its 20-day average, institutional accumulation or distribution is underway. The elevated volume in the direction of the price move indicates conviction, and the move is likely to continue over 1–3 days.",
    marketInefficiency:
      "Institutional order flow in Indian markets is large relative to average daily volume for many F&O stocks. Above-average volume signals that large participants are actively building positions, creating near-term price momentum.",
    expectedEdge:
      "1-3 day continuation after volume breakout. Expected Sharpe > 0.6 OOS.",
    expectedFailureMode:
      "Institutional distribution (selling) at volume spikes looks identical to accumulation in the filter — the strategy enters on both. Block trades that move volume above threshold without directional intent.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING"],
    expectedHoldingPeriod: "1–3 trading days",
    whyEdgeShouldExist:
      "Volume-price divergence studies consistently show that volume is a leading indicator of price direction continuation in equity markets.",
    whatWouldInvalidate:
      "OOS Sharpe < 0.3. Win-rate below 45%. Volume ratio 1.5× threshold: if 2× threshold produces materially better results, the 1.5× is too loose.",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "INDIA_OI_BUILDUP",
    hypothesisVersion: "1.0.0",
    hypothesis:
      "Open-interest build-up direction (long built-up, short built-up, short covering, long unwinding) reflects the net positioning decision of all market participants and provides information about probable near-term price direction in Indian F&O markets.",
    marketInefficiency:
      "NSE F&O OI data is publicly available but its directional implication is non-trivial to interpret. The PCR-adjusted OI delta provides information about net institutional directional bias.",
    expectedEdge:
      "Signals aligned with OI build-up direction should produce higher win-rates than random entry. Expected improvement in win-rate of 5-10% over baseline.",
    expectedFailureMode:
      "OI data is delayed and may reflect yesterday's positions. Expiry-week unwinding creates misleading OI signals that are not predictive of next-day direction.",
    expectedRegime: ["BULL_TRENDING", "BEAR_TRENDING", "EXPIRY_DAY", "NORMAL_DAY"],
    expectedHoldingPeriod: "Intraday to expiry",
    whyEdgeShouldExist:
      "Options market positioning in Indian indices is a well-documented predictor of near-term directional bias. PCR extremes have historically preceded reversals.",
    whatWouldInvalidate:
      "Win-rate improvement vs random entry below 3% (OI signal has no predictive value). Performance during expiry week materially worse than non-expiry (expiry-week OI noise dominates).",
    status: "DEFINED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
  {
    strategyId: "STRATEGY_LAB_USER",
    hypothesisVersion: "0.0.1",
    hypothesis:
      "User-defined strategies parsed from natural-language prompts. Each user strategy has an implicit hypothesis that must be stated before live trading.",
    marketInefficiency: "User-defined — unknown until hypothesis is declared.",
    expectedEdge: "User-defined — unknown until hypothesis is declared.",
    expectedFailureMode: "Over-fitting to historical data via natural-language parameter selection.",
    expectedRegime: ["NORMAL_DAY"],
    expectedHoldingPeriod: "User-defined",
    whyEdgeShouldExist: "Unknown — user must declare hypothesis before promotion.",
    whatWouldInvalidate: "User must define invalidation criteria.",
    status: "UNVALIDATED",
    definedAt: "2024-01-01T00:00:00Z",
    lastReviewedAt: "2025-09-01T00:00:00Z",
  },
];

// ─── Hypothesis Registry ──────────────────────────────────────────────────────

class HypothesisRegistryImpl {
  private readonly hypotheses: Map<string, StrategyHypothesis>;

  constructor(catalog: StrategyHypothesis[]) {
    this.hypotheses = new Map(catalog.map((h) => [h.strategyId, h]));
  }

  get(strategyId: string): StrategyHypothesis | undefined {
    return this.hypotheses.get(strategyId);
  }

  getAll(): StrategyHypothesis[] {
    return Array.from(this.hypotheses.values());
  }

  /** Returns UNVALIDATED sentinel for strategies with no declared hypothesis. */
  getOrDefault(strategyId: string): StrategyHypothesis {
    return (
      this.hypotheses.get(strategyId) ?? {
        strategyId,
        hypothesisVersion: "0.0.0",
        hypothesis: "NO HYPOTHESIS DECLARED",
        marketInefficiency: "UNDEFINED",
        expectedEdge: "UNDEFINED",
        expectedFailureMode: "UNDEFINED",
        expectedRegime: [],
        expectedHoldingPeriod: "UNDEFINED",
        whyEdgeShouldExist: "UNDEFINED",
        whatWouldInvalidate: "UNDEFINED",
        status: "UNVALIDATED",
        definedAt: new Date().toISOString(),
        lastReviewedAt: new Date().toISOString(),
      }
    );
  }

  isValidated(strategyId: string): boolean {
    const h = this.hypotheses.get(strategyId);
    return h?.status === "DEFINED";
  }
}

export const HypothesisRegistry = new HypothesisRegistryImpl(HYPOTHESIS_CATALOG);
