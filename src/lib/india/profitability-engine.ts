/**
 * India Profitability-Selection Engine  (v1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns the India opportunity engine from a signal-VALIDATION pipeline into a
 * profitability-SELECTION pipeline. It answers one question:
 *
 *   "Is this trade worth taking AFTER probability, payoff, cost, slippage,
 *    liquidity and uncertainty?"
 *
 * The decision is based on NET expected value — never gross. The forensic audit
 * (`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md`) found costs/slippage were routinely
 * zeroed (market impact = 0, resolver applied no costs). This engine models the
 * full Indian F&O cost stack and realistic slippage, stresses costs to 3×, and
 * rejects fragile signals via counterfactual perturbation.
 *
 * Consumes the outputs of the engines already built:
 *   • calibrated probability  → `ml-meta-decision`   (P(win) input)
 *   • predictive quality      → `predictive-quality-engine`
 *   • evidence grade          → `evidence-grading-engine`
 *   • strategy×regime scoring  → `strategy-regime-scoring`
 * (passed in as inputs, so this module stays PURE and unit-testable).
 *
 * All computation is deterministic. I/O-free; no `server-only` guard.
 */

export const PROFITABILITY_ENGINE_VERSION = "pfe-1.0.0";

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number): number => clamp(x, 0, 1);

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Full India F&O cost stack
// ═══════════════════════════════════════════════════════════════════════════

export type InstrumentKind = "INDEX_OPTION" | "STOCK_OPTION" | "INDEX_FUT" | "STOCK_FUT" | "EQUITY";

/**
 * Regulatory + broker cost rates for one instrument kind. All rates are
 * fractions of the relevant notional unless noted. These are realistic NSE/SEBI
 * defaults (FY-2024-ish); they are inputs so they can be updated without code
 * changes.
 */
export interface CostRates {
  /** Flat brokerage per round trip (INR). */
  brokerageRoundTrip: number;
  /** STT as a fraction of the SELL notional (options: on premium; futures: on turnover). */
  sttRate: number;
  /** Exchange transaction charge as a fraction of turnover (per side). */
  exchangeRate: number;
  /** SEBI turnover fee as a fraction of turnover (per side). */
  sebiRate: number;
  /** GST rate applied to (brokerage + exchange + SEBI). */
  gstRate: number;
  /** Stamp duty as a fraction of the BUY notional. */
  stampDutyRate: number;
}

/** Realistic NSE cost rates per instrument kind. */
export const COST_RATES: Record<InstrumentKind, CostRates> = {
  INDEX_OPTION: { brokerageRoundTrip: 40, sttRate: 0.001, exchangeRate: 0.0003503, sebiRate: 0.000001, gstRate: 0.18, stampDutyRate: 0.00003 },
  STOCK_OPTION: { brokerageRoundTrip: 40, sttRate: 0.001, exchangeRate: 0.0003503, sebiRate: 0.000001, gstRate: 0.18, stampDutyRate: 0.00003 },
  INDEX_FUT:    { brokerageRoundTrip: 40, sttRate: 0.0002, exchangeRate: 0.0000173, sebiRate: 0.000001, gstRate: 0.18, stampDutyRate: 0.00002 },
  STOCK_FUT:    { brokerageRoundTrip: 40, sttRate: 0.0002, exchangeRate: 0.0000173, sebiRate: 0.000001, gstRate: 0.18, stampDutyRate: 0.00002 },
  EQUITY:       { brokerageRoundTrip: 0,  sttRate: 0.001, exchangeRate: 0.0000297, sebiRate: 0.000001, gstRate: 0.18, stampDutyRate: 0.00015 },
};

/** Itemised cost breakdown for one round-trip trade, expressed as % of entry. */
export interface CostBreakdownPct {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  gst: number;
  stampDuty: number;
  spread: number;
  slippage: number;
  marketImpact: number;
  /** Grand total round-trip cost as % of entry notional. */
  totalPct: number;
}

/**
 * Compute the full round-trip cost as a % of entry, given the instrument, the
 * per-lot notional, and the (separately-modeled) spread/slippage/impact in % of
 * price. Regulatory rates are applied on both sides where appropriate.
 */
export function computeCostBreakdown(params: {
  instrument: InstrumentKind;
  /** Notional value of the position (entry price × lot size × lots), INR. */
  notionalINR: number;
  /** Spread cost as % of price (round-trip), from the slippage model. */
  spreadPct: number;
  /** Slippage cost as % of price (round-trip), from the slippage model. */
  slippagePct: number;
  /** Market-impact cost as % of price (round-trip), from the slippage model. */
  marketImpactPct: number;
  rates?: CostRates;
}): CostBreakdownPct {
  const r = params.rates ?? COST_RATES[params.instrument];
  const notional = Math.max(1, params.notionalINR);

  const brokeragePct = (r.brokerageRoundTrip / notional) * 100;
  const sttPct = r.sttRate * 100;                         // sell side
  const exchangePct = r.exchangeRate * 2 * 100;           // both sides
  const sebiPct = r.sebiRate * 2 * 100;                   // both sides
  // GST applies to brokerage + exchange + SEBI (not STT / stamp).
  const gstPct = r.gstRate * (brokeragePct + exchangePct + sebiPct);
  const stampPct = r.stampDutyRate * 100;                 // buy side

  const totalPct =
    brokeragePct + sttPct + exchangePct + sebiPct + gstPct + stampPct +
    params.spreadPct + params.slippagePct + params.marketImpactPct;

  return {
    brokerage: brokeragePct,
    stt: sttPct,
    exchange: exchangePct,
    sebi: sebiPct,
    gst: gstPct,
    stampDuty: stampPct,
    spread: params.spreadPct,
    slippage: params.slippagePct,
    marketImpact: params.marketImpactPct,
    totalPct,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Slippage + options microstructure model
// ═══════════════════════════════════════════════════════════════════════════

export type Moneyness = "ITM" | "ATM" | "OTM" | "DEEP_OTM";

/** Option microstructure inputs (only for option instruments). */
export interface OptionMicrostructure {
  /** Bid/ask spread as % of the option premium. */
  bidAskSpreadPct: number;
  iv: number;                 // implied volatility (annualised %, e.g. 18)
  theta: number;              // per-day premium decay (INR)
  gamma: number;
  vega: number;
  oi: number;                 // open interest (contracts)
  volume: number;             // today's traded contracts
  moneyness: Moneyness;
  /** Sessions until expiry (0 = expiry day). */
  daysToExpiry: number;
}

/** Inputs to the slippage model. */
export interface SlippageInputs {
  instrument: InstrumentKind;
  /** Quoted bid/ask spread as % of price (underlying or option). */
  quotedSpreadPct: number | null;
  /** Liquidity score [0,1] (1 = very deep). */
  liquidity: number;
  /** Relative volume vs 20d avg (RVOL). */
  relativeVolume: number;
  /** Realized volatility proxy [0,1] (higher = more slippage). */
  volatility: number;
  /** IST minutes from 09:15 open (drives time-of-day widening). */
  minutesFromOpen: number;
  /** Order size relative to typical top-of-book depth [0,∞); 1 = one level. */
  orderSizeRatio: number;
  /** Option microstructure (null for non-options). */
  option: OptionMicrostructure | null;
}

export interface SlippageResult {
  /** Round-trip spread cost as % of price. */
  spreadPct: number;
  /** Round-trip slippage cost as % of price. */
  slippagePct: number;
  /** Round-trip market-impact cost as % of price. */
  marketImpactPct: number;
  /** The dominant driver, for attribution. */
  reasons: string[];
}

/** Time-of-day slippage multiplier: wide at open/close, tight mid-session. */
function todSlippageMultiplier(minutesFromOpen: number): number {
  if (minutesFromOpen < 15) return 1.8;      // 09:15–09:30 — chaotic open
  if (minutesFromOpen < 45) return 1.3;      // 09:30–10:00
  if (minutesFromOpen > 360) return 1.6;     // >15:15 — closing auction pressure
  if (minutesFromOpen > 300) return 1.2;     // 14:15–15:15
  return 1.0;                                // mid-session
}

/** Option-moneyness slippage multiplier: OTM/deep-OTM are slippier. */
function moneynessMultiplier(m: Moneyness): number {
  switch (m) {
    case "ITM": return 1.1;
    case "ATM": return 1.0;
    case "OTM": return 1.4;
    case "DEEP_OTM": return 2.2;
  }
}

/**
 * Model realistic round-trip slippage (spread + impact) from liquidity, spread,
 * volume, volatility, instrument type, time-of-day, and — for options — option
 * moneyness, option liquidity (OI/volume) and order size.
 *
 * The result is fed into `computeCostBreakdown` so slippage lands in the net-EV
 * cost total. Deterministic.
 */
export function modelSlippage(inp: SlippageInputs): SlippageResult {
  const reasons: string[] = [];

  // Base spread: use the quoted spread if present, else infer from liquidity.
  let baseSpread = inp.quotedSpreadPct != null
    ? inp.quotedSpreadPct
    : clamp(0.05 + (1 - clamp01(inp.liquidity)) * 0.6, 0.02, 1.0); // 2bps..1%
  if (inp.option) baseSpread = inp.option.bidAskSpreadPct;

  // Liquidity multiplier: thin books widen effective slippage.
  const liqMult = clamp(1 + (1 - clamp01(inp.liquidity)) * 1.5, 1, 2.5);
  // Volume multiplier: low RVOL → worse fills.
  const volMult = clamp(inp.relativeVolume >= 1 ? 1 : 1 + (1 - inp.relativeVolume) * 0.8, 1, 1.8);
  // Volatility multiplier.
  const volatilityMult = clamp(1 + inp.volatility * 0.8, 1, 1.8);
  // Time-of-day.
  const todMult = todSlippageMultiplier(inp.minutesFromOpen);
  // Order-size (square-root market impact law).
  const sizeMult = clamp(Math.sqrt(Math.max(1, inp.orderSizeRatio)), 1, 3);

  let optionMult = 1;
  if (inp.option) {
    optionMult *= moneynessMultiplier(inp.option.moneyness);
    // option-liquidity: low OI or volume widens further
    const oiThin = inp.option.oi < 5000;
    const volThin = inp.option.volume < 1000;
    if (oiThin) { optionMult *= 1.3; reasons.push("thin_option_oi"); }
    if (volThin) { optionMult *= 1.3; reasons.push("thin_option_volume"); }
    // near expiry, spreads gap out
    if (inp.option.daysToExpiry <= 0) { optionMult *= 1.4; reasons.push("expiry_day_slippage"); }
    else if (inp.option.daysToExpiry <= 1) { optionMult *= 1.2; }
  }

  // Round-trip spread cost (cross the spread on both entry and exit).
  const spreadPct = baseSpread * 2 * optionMult;
  // Slippage beyond the spread from vol / volume / time-of-day.
  const slippagePct = baseSpread * (volMult * volatilityMult * todMult - 1) * liqMult;
  // Market impact from order size (square-root law) on the base spread.
  const marketImpactPct = baseSpread * (sizeMult - 1) * liqMult;

  // Greeks-driven execution friction for options: high gamma/vega near expiry
  // makes fills unstable (the quote moves while you cross the spread), and high
  // IV widens quotes. This adds to slippage (NOT direction — greeks are an
  // execution-cost input here, theta is a holding cost handled by the caller's
  // expectedWinR/expectedLossR geometry).
  let greeksSlip = 0;
  if (inp.option) {
    const o = inp.option;
    const ivFactor = clamp(o.iv / 30, 0, 2);            // IV 30% → 1×
    const gammaVegaFactor = clamp(Math.abs(o.gamma) * 100 + Math.abs(o.vega) / 50, 0, 1.5);
    const expiryFactor = o.daysToExpiry <= 0 ? 1.5 : o.daysToExpiry <= 1 ? 1.2 : 1;
    greeksSlip = baseSpread * 0.25 * ivFactor * (1 + gammaVegaFactor) * expiryFactor;
    if (ivFactor > 1.2) reasons.push("high_iv_widens_quotes");
    if (gammaVegaFactor > 0.8) reasons.push("high_gamma_vega_unstable_fills");
  }

  if (todMult > 1.3) reasons.push(`tod_widened:${todMult.toFixed(1)}x`);
  if (liqMult > 1.5) reasons.push("thin_liquidity");
  if (sizeMult > 1.5) reasons.push("large_order_impact");

  return {
    spreadPct: Math.max(0, spreadPct),
    slippagePct: Math.max(0, slippagePct + greeksSlip),
    marketImpactPct: Math.max(0, marketImpactPct),
    reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Net EV + cost stress
// ═══════════════════════════════════════════════════════════════════════════

export interface NetEVInput {
  /** Calibrated P(win) ∈ [0,1] (from the ML meta layer — NOT confidence). */
  pWin: number;
  /** Expected win in R (reward captured on a win), > 0. */
  expectedWinR: number;
  /** Expected loss in R on a loss, > 0 (magnitude). */
  expectedLossR: number;
  /** Risk per trade as % of entry (|entry − stop| / entry × 100) — converts R→%. */
  riskPct: number;
  /** Full cost breakdown (% of entry) at 1× costs. */
  cost: CostBreakdownPct;
}

export interface NetEVResult {
  /** Gross EV in % of entry (before costs). */
  grossEVPct: number;
  /** Net EV in % of entry at 1× costs. */
  netEVPct: number;
  /** Net EV in R units at 1× costs. */
  netEVR: number;
  pWin: number;
  pLoss: number;
  totalCostPct: number;
  // Cost stress
  evAt1x: number;
  evAt1_5x: number;
  evAt2x: number;
  evAt3x: number;
  /** [0,1]: how much of the gross edge survives cost stress (1 = fully robust). */
  costRobustnessScore: number;
  /** True only if net EV is still positive at 2× costs. */
  survives2x: boolean;
  reasons: string[];
}

/**
 * Compute net EV and the cost-stress ladder. Gross EV is the probability-weighted
 * payoff in % of entry; net subtracts the full cost stack. The cost-stress ladder
 * scales ONLY the frictional (non-regulatory-flat) portion is not separated here
 * — we scale the whole realistic cost total, which is the conservative choice.
 */
export function computeNetEV(inp: NetEVInput): NetEVResult {
  const reasons: string[] = [];
  const pWin = clamp01(inp.pWin);
  const pLoss = 1 - pWin;

  // Convert R payoffs to % of entry via riskPct (1R = riskPct%).
  const winPct = inp.expectedWinR * inp.riskPct;
  const lossPct = inp.expectedLossR * inp.riskPct;

  const grossEVPct = pWin * winPct - pLoss * lossPct;
  const cost1x = inp.cost.totalPct;

  const evAt = (mult: number): number => grossEVPct - cost1x * mult;
  const evAt1x = evAt(1);
  const evAt1_5x = evAt(1.5);
  const evAt2x = evAt(2);
  const evAt3x = evAt(3);

  const netEVPct = evAt1x;
  const netEVR = inp.riskPct > 0 ? netEVPct / inp.riskPct : 0;

  // Cost robustness: fraction of gross edge that survives 2× costs, clamped.
  // If gross EV ≤ 0 there is no edge to protect → 0.
  const costRobustnessScore = grossEVPct > 1e-9 ? clamp01(evAt2x / grossEVPct) : 0;
  const survives2x = evAt2x > 0;

  if (grossEVPct > 0 && netEVPct <= 0) reasons.push("edge_consumed_by_costs");
  if (!survives2x && netEVPct > 0) reasons.push("cost_fragile_fails_2x");

  return {
    grossEVPct,
    netEVPct,
    netEVR,
    pWin,
    pLoss,
    totalCostPct: cost1x,
    evAt1x,
    evAt1_5x,
    evAt2x,
    evAt3x,
    costRobustnessScore,
    survives2x,
    reasons,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Counterfactual perturbations + robustnessScore
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inputs needed to re-evaluate net EV under a perturbation. The perturbation
 * functions mutate a COPY and recompute net EV, so a robust signal is one whose
 * edge survives reasonable changes to entry timing, slippage, stop and target.
 */
export interface CounterfactualInput {
  base: NetEVInput;
  /** Per-candle expected adverse drift in R when entry is delayed (edge decay). */
  delayDecayRPerCandle: number;
  /** Per-hour expected adverse drift in R when entry is an hour late. */
  hourlyDecayR: number;
}

export interface CounterfactualScenario {
  name: string;
  netEVPct: number;
  positive: boolean;
}

export interface RobustnessResult {
  scenarios: CounterfactualScenario[];
  /** Fraction of scenarios that keep net EV positive ∈ [0,1]. */
  robustnessScore: number;
  /** Worst-case net EV across all scenarios. */
  worstCaseNetEVPct: number;
  /** True when the signal is too fragile to trade. */
  fragile: boolean;
  reasons: string[];
}

/**
 * Run the required counterfactual perturbations and score robustness:
 *   • entry delayed 1 candle / 2 candles (edge decays)
 *   • slippage doubled
 *   • stop 10% wider (larger loss, larger risk denominator)
 *   • target 10% closer / 10% farther
 *   • entry taken one hour later (edge decays)
 *
 * A robust signal retains positive net EV under these reasonable perturbations.
 * `robustnessScore` = fraction of scenarios still positive; `fragile` when the
 * base is positive but robustness is weak or the worst case is badly negative.
 */
export function runCounterfactuals(inp: CounterfactualInput): RobustnessResult {
  const scenarios: CounterfactualScenario[] = [];
  const reasons: string[] = [];

  const evOf = (i: NetEVInput): number => computeNetEV(i).netEVPct;

  // baseline
  const baseEV = evOf(inp.base);
  scenarios.push({ name: "base", netEVPct: baseEV, positive: baseEV > 0 });

  // entry delayed 1/2 candles → win capture shrinks by the decay
  for (const c of [1, 2]) {
    const decay = inp.delayDecayRPerCandle * c;
    const ev = evOf({ ...inp.base, expectedWinR: Math.max(0, inp.base.expectedWinR - decay) });
    scenarios.push({ name: `delay_${c}_candle`, netEVPct: ev, positive: ev > 0 });
  }

  // slippage doubled → double the slippage component only
  const dbl = { ...inp.base, cost: { ...inp.base.cost, slippage: inp.base.cost.slippage * 2, totalPct: inp.base.cost.totalPct + inp.base.cost.slippage } };
  const evSlip = evOf(dbl);
  scenarios.push({ name: "slippage_2x", netEVPct: evSlip, positive: evSlip > 0 });

  // stop 10% wider → expectedLossR ×1.1 AND riskPct ×1.1 (payoffs in R rescale)
  const wider = { ...inp.base, expectedLossR: inp.base.expectedLossR * 1.1, riskPct: inp.base.riskPct * 1.1, expectedWinR: inp.base.expectedWinR / 1.1 };
  const evWider = evOf(wider);
  scenarios.push({ name: "stop_10pct_wider", netEVPct: evWider, positive: evWider > 0 });

  // target 10% closer / farther → expectedWinR scaled
  const closer = { ...inp.base, expectedWinR: inp.base.expectedWinR * 0.9 };
  const farther = { ...inp.base, expectedWinR: inp.base.expectedWinR * 1.1 };
  const evCloser = evOf(closer);
  const evFarther = evOf(farther);
  scenarios.push({ name: "target_10pct_closer", netEVPct: evCloser, positive: evCloser > 0 });
  scenarios.push({ name: "target_10pct_farther", netEVPct: evFarther, positive: evFarther > 0 });

  // entry one hour later → hourly edge decay
  const late = { ...inp.base, expectedWinR: Math.max(0, inp.base.expectedWinR - inp.hourlyDecayR) };
  const evLate = evOf(late);
  scenarios.push({ name: "entry_1hr_later", netEVPct: evLate, positive: evLate > 0 });

  const positives = scenarios.filter((s) => s.positive).length;
  const robustnessScore = clamp01(positives / scenarios.length);
  const worstCaseNetEVPct = Math.min(...scenarios.map((s) => s.netEVPct));

  // Fragile: base positive but the edge does not survive reasonable perturbation.
  const fragile = baseEV > 0 && (robustnessScore < 0.7 || worstCaseNetEVPct < -Math.max(0.05, baseEV));
  if (fragile) reasons.push(`fragile:robustness=${robustnessScore.toFixed(2)},worst=${worstCaseNetEVPct.toFixed(3)}%`);

  return { scenarios, robustnessScore, worstCaseNetEVPct, fragile, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Derivatives confirm-only guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Derivatives evidence for a candidate. `directionalThesisSupported` is TRUE only
 * when a NON-derivatives source (price structure / trend / momentum) already
 * supports the direction. Max-pain / PCR / OI are CONFIRMATION-only unless the
 * strategy is a statistically-validated options-flow strategy.
 */
export interface DerivativesEvidence {
  /** Is the direction already supported by non-derivatives price/structure evidence? */
  directionalThesisSupported: boolean;
  /** Max-pain pull agrees with the trade direction. */
  maxPainAgrees: boolean;
  /** PCR agrees with the trade direction. */
  pcrAgrees: boolean;
  /** OI build-up agrees with the trade direction. */
  oiAgrees: boolean;
  /** Is this a strategy whose EDGE is derivatives (validated OOS)? */
  isValidatedOptionsFlowStrategy: boolean;
}

export interface DerivativesGate {
  /** Whether the derivatives evidence may be USED to size up/confirm. */
  allowed: boolean;
  /** Whether derivatives ALONE created a directional trade (forbidden). */
  derivativesAloneRejected: boolean;
  /** Confirmation strength ∈ [0,1] added on top of a supported thesis. */
  confirmationStrength: number;
  reasons: string[];
}

/**
 * Enforce: max-pain / PCR / OI must CONFIRM an already-supported thesis or come
 * from a statistically-validated independent options-flow strategy. They may
 * NEVER, on their own, create a directional trade.
 */
export function evaluateDerivativesGate(ev: DerivativesEvidence): DerivativesGate {
  const reasons: string[] = [];
  const agreeCount = [ev.maxPainAgrees, ev.pcrAgrees, ev.oiAgrees].filter(Boolean).length;

  if (!ev.directionalThesisSupported && !ev.isValidatedOptionsFlowStrategy) {
    // derivatives are the ONLY thing pointing this direction → reject the use.
    if (agreeCount > 0) reasons.push("derivatives_alone_cannot_create_direction");
    return { allowed: false, derivativesAloneRejected: agreeCount > 0, confirmationStrength: 0, reasons };
  }

  // Confirmation strength scales with how many independent derivatives agree.
  const confirmationStrength = clamp01(agreeCount / 3);
  if (ev.isValidatedOptionsFlowStrategy) reasons.push("validated_options_flow_independent_evidence");
  else reasons.push("derivatives_confirm_supported_thesis");
  return { allowed: true, derivativesAloneRejected: false, confirmationStrength, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — The profitability-selection pipeline + decision
// ═══════════════════════════════════════════════════════════════════════════

export type OpportunityDecision = "TRADE" | "WATCH" | "WAIT" | "NO_TRADE";

/**
 * The pipeline input bundles the outputs of the upstream engines (passed in so
 * this module is pure). Each field names the stage it comes from.
 */
export interface ProfitabilityPipelineInput {
  // ── identity ──
  instrument: InstrumentKind;
  strategyId: string;

  // ── Predictive Quality (predictive-quality-engine) ──
  qualityScore: number;           // 0–100

  // ── Calibrated Probability (ml-meta-decision) ──
  calibratedPWin: number;         // [0,1]
  probabilityLowerBound: number;  // [0,1]
  modelAgreement: number;         // [0,1]
  predictionUncertainty: number;  // [0,1]
  /** Heuristic conviction — carried, NEVER used as probability. */
  confidence: number;

  // ── Payoff geometry ──
  expectedWinR: number;
  expectedLossR: number;
  riskPct: number;
  notionalINR: number;

  // ── Slippage inputs (→ cost) ──
  slippage: SlippageInputs;

  // ── Derivatives evidence ──
  derivatives: DerivativesEvidence;

  // ── Correlation / conflict / abstention / risk (from upstream) ──
  /** Correlation with existing same-direction positions [0,1]. */
  clusterCorrelation: number;
  /** True if a multi-timeframe / derivatives conflict was detected. */
  hasConflict: boolean;
  /** True if the meta layer abstained. */
  mlAbstained: boolean;
  /** True if a hard risk gate blocks the trade (drawdown/kill-switch/exposure). */
  riskBlocked: boolean;
  /** Strategy suppressed in the current regime (from strategy-regime selector). */
  strategySuppressed: boolean;

  // ── Counterfactual decay assumptions ──
  delayDecayRPerCandle: number;
  hourlyDecayR: number;

  // ── Thresholds (learned upstream; defaults below) ──
  config?: Partial<ProfitabilityConfig>;
}

export interface ProfitabilityConfig {
  /** Net EV must exceed this (% of entry) to TRADE. */
  minNetEVPct: number;
  /** Cost robustness floor to TRADE. */
  minCostRobustness: number;
  /** Robustness (counterfactual) floor to TRADE. */
  minRobustness: number;
  /** Min quality to TRADE. */
  minQuality: number;
  /** Min calibrated probability to TRADE. */
  minPWin: number;
  /** Max prediction uncertainty to TRADE. */
  maxUncertainty: number;
  /** Cluster correlation above which the trade is demoted to WATCH. */
  maxClusterCorrelation: number;
}

export const DEFAULT_PROFITABILITY_CONFIG: ProfitabilityConfig = {
  minNetEVPct: 0.0,        // must be net-positive after realistic costs
  minCostRobustness: 0.4,  // survive a good chunk of 2× cost stress
  minRobustness: 0.7,      // ≥70% of counterfactuals stay positive
  minQuality: 55,
  minPWin: 0.5,
  maxUncertainty: 0.6,
  maxClusterCorrelation: 0.8,
};

export interface ProfitabilityResult {
  version: string;
  decision: OpportunityDecision;
  /** Final letter grade gate: A_PLUS/A/B/C/REJECT (net-EV gated). */
  grade: "A_PLUS" | "A" | "B" | "C" | "REJECT";
  netEV: NetEVResult;
  cost: CostBreakdownPct;
  slippage: SlippageResult;
  robustness: RobustnessResult;
  derivativesGate: DerivativesGate;
  /** Stage-by-stage trace for auditability. */
  stages: Array<{ stage: string; passed: boolean; detail: string }>;
  reasons: string[];
}

/**
 * Run the full profitability-selection pipeline:
 *
 *   Universe → Context → Multi-layer → Derivatives → Predictive Quality →
 *   Calibrated Probability → Net EV → Cost Stress → Counterfactual →
 *   Correlation Cluster → Conflict Resolution → Abstention → Risk → Grade
 *
 * The upstream stages are supplied as inputs; this function performs the
 * profitability-selection stages (derivatives gate → net EV → cost stress →
 * counterfactual → correlation → conflict → abstention → risk → grade) and
 * returns a TRADE / WATCH / WAIT / NO_TRADE decision. PURE + DETERMINISTIC.
 */
export function runProfitabilityPipeline(input: ProfitabilityPipelineInput): ProfitabilityResult {
  const cfg: ProfitabilityConfig = { ...DEFAULT_PROFITABILITY_CONFIG, ...input.config };
  const stages: Array<{ stage: string; passed: boolean; detail: string }> = [];
  const reasons: string[] = [];

  // ── Derivatives gate (confirm-only) ─────────────────────────────────────────
  const derivativesGate = evaluateDerivativesGate(input.derivatives);
  stages.push({ stage: "Derivatives", passed: !derivativesGate.derivativesAloneRejected, detail: derivativesGate.reasons.join(";") });

  // ── Slippage → cost stack ────────────────────────────────────────────────────
  const slippage = modelSlippage(input.slippage);
  const cost = computeCostBreakdown({
    instrument: input.instrument,
    notionalINR: input.notionalINR,
    spreadPct: slippage.spreadPct,
    slippagePct: slippage.slippagePct,
    marketImpactPct: slippage.marketImpactPct,
  });

  // ── Net EV + cost stress ─────────────────────────────────────────────────────
  const netEVInput: NetEVInput = {
    pWin: input.calibratedPWin,
    expectedWinR: input.expectedWinR,
    expectedLossR: input.expectedLossR,
    riskPct: input.riskPct,
    cost,
  };
  const netEV = computeNetEV(netEVInput);
  stages.push({ stage: "NetEV", passed: netEV.netEVPct > cfg.minNetEVPct, detail: `netEV=${netEV.netEVPct.toFixed(3)}%` });
  stages.push({ stage: "CostStress", passed: netEV.survives2x, detail: `robustness=${netEV.costRobustnessScore.toFixed(2)} survives2x=${netEV.survives2x}` });

  // ── Counterfactual robustness ────────────────────────────────────────────────
  const robustness = runCounterfactuals({ base: netEVInput, delayDecayRPerCandle: input.delayDecayRPerCandle, hourlyDecayR: input.hourlyDecayR });
  stages.push({ stage: "Counterfactual", passed: !robustness.fragile, detail: `robustness=${robustness.robustnessScore.toFixed(2)} worst=${robustness.worstCaseNetEVPct.toFixed(3)}%` });

  // ── Correlation cluster ──────────────────────────────────────────────────────
  const correlationOk = input.clusterCorrelation <= cfg.maxClusterCorrelation;
  stages.push({ stage: "CorrelationCluster", passed: correlationOk, detail: `corr=${input.clusterCorrelation.toFixed(2)}` });

  // ── Conflict resolution ──────────────────────────────────────────────────────
  stages.push({ stage: "ConflictResolution", passed: !input.hasConflict, detail: input.hasConflict ? "conflict" : "clear" });

  // ── Abstention ───────────────────────────────────────────────────────────────
  const abstain = input.mlAbstained || input.predictionUncertainty > cfg.maxUncertainty;
  stages.push({ stage: "Abstention", passed: !abstain, detail: `mlAbstained=${input.mlAbstained} uncertainty=${input.predictionUncertainty.toFixed(2)}` });

  // ── Risk ─────────────────────────────────────────────────────────────────────
  stages.push({ stage: "Risk", passed: !input.riskBlocked, detail: input.riskBlocked ? "risk_blocked" : "ok" });

  // ── Grade (net-EV gated: gross EV can NEVER earn A/A+) ───────────────────────
  const grade = gradeProfitability(input, netEV, robustness, cfg);
  stages.push({ stage: "Grade", passed: grade !== "REJECT", detail: grade });

  // ── Decision ─────────────────────────────────────────────────────────────────
  let decision: OpportunityDecision;

  // Hard NO_TRADE conditions (any → NO_TRADE).
  if (
    input.riskBlocked ||
    input.strategySuppressed ||
    derivativesGate.derivativesAloneRejected ||
    netEV.netEVPct <= cfg.minNetEVPct ||
    !netEV.survives2x ||
    grade === "REJECT"
  ) {
    decision = "NO_TRADE";
    if (input.riskBlocked) reasons.push("risk_blocked");
    if (input.strategySuppressed) reasons.push("strategy_suppressed_in_regime");
    if (derivativesGate.derivativesAloneRejected) reasons.push("derivatives_alone");
    if (netEV.netEVPct <= cfg.minNetEVPct) reasons.push("non_positive_net_ev");
    if (!netEV.survives2x) reasons.push("fails_2x_cost_stress");
  } else if (abstain) {
    decision = "WAIT";                    // usable edge but the model is unsure — wait for clarity
    reasons.push("abstain_wait_for_clarity");
  } else if (input.hasConflict) {
    decision = "WAIT";
    reasons.push("timeframe_or_derivatives_conflict");
  } else if (robustness.fragile) {
    decision = "WATCH";                   // positive but fragile — watch, don't commit
    reasons.push("fragile_watch_only");
  } else if (!correlationOk) {
    decision = "WATCH";                   // edge exists but correlated with book — watch
    reasons.push("high_cluster_correlation");
  } else if (grade === "C") {
    decision = "WATCH";
    reasons.push("marginal_edge_watch");
  } else {
    decision = "TRADE";
    reasons.push("net_positive_robust_edge");
  }

  return { version: PROFITABILITY_ENGINE_VERSION, decision, grade, netEV, cost, slippage, robustness, derivativesGate, stages, reasons };
}

/**
 * Grade the opportunity on NET EV + robustness + quality + calibrated
 * probability. GROSS EV can NEVER produce A/A+: A-tier requires net EV positive
 * AND survival of 2× cost stress AND counterfactual robustness.
 */
export function gradeProfitability(
  input: Pick<ProfitabilityPipelineInput, "qualityScore" | "calibratedPWin" | "probabilityLowerBound">,
  netEV: NetEVResult,
  robustness: RobustnessResult,
  cfg: ProfitabilityConfig,
): "A_PLUS" | "A" | "B" | "C" | "REJECT" {
  // Hard reject: no net edge, or edge dies under 2× costs.
  if (netEV.netEVPct <= 0 || !netEV.survives2x) return "REJECT";

  const q = input.qualityScore;
  const p = input.calibratedPWin;
  const pLB = input.probabilityLowerBound;

  // A+ : strong net EV survives 3× costs, robust, high quality & calibrated prob.
  if (netEV.evAt3x > 0 && netEV.costRobustnessScore >= 0.6 && robustness.robustnessScore >= 0.85 &&
      q >= 75 && p >= 0.62 && pLB >= 0.5) {
    return "A_PLUS";
  }
  // A : net EV survives 2× costs comfortably, robust, good quality.
  if (netEV.evAt2x > 0 && netEV.costRobustnessScore >= cfg.minCostRobustness && robustness.robustnessScore >= cfg.minRobustness &&
      q >= cfg.minQuality && p >= cfg.minPWin) {
    return "A";
  }
  // B : net positive, reasonably robust.
  if (netEV.netEVPct > 0 && robustness.robustnessScore >= 0.6 && p >= 0.5) {
    return "B";
  }
  // C : net positive but weak / fragile.
  if (netEV.netEVPct > 0) return "C";
  return "REJECT";
}
