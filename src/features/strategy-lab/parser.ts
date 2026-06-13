import type {
  Comparator,
  Condition,
  IndicatorRef,
  LogicOp,
  Operand,
  ParsedStrategy,
  RiskParams,
  Rule,
  Side,
} from "@/features/strategy-lab/types";

/**
 * Minimal but practical English → strategy AST compiler.
 *
 * We deliberately avoid pulling in a real NL parser — every retail
 * "buy when X, sell when Y" rule shape can be matched with a small set of
 * regexes against a normalized prompt. Anything that doesn't match emits a
 * warning so the user can rephrase.
 *
 * Supported example prompts:
 *   - "Buy BTC when RSI drops below 30 and sell when RSI crosses above 70.
 *      Stop loss 2%, take profit 5%."
 *   - "Long when EMA(20) crosses above EMA(50). Exit after 10 days."
 *   - "Short when MACD histogram turns negative and price drops 3% in 4
 *      hours. Stop 1.5x ATR, target 3x ATR."
 *   - "Buy when price breaks above the 20-day high with volume above 1.5x
 *      average."
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Indicator phrase matcher — turns "rsi", "rsi(14)", "the 20-day ema",
// "macd histogram", "price", "volume", "atr" into an `Operand`.
// ───────────────────────────────────────────────────────────────────────────
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

function parseOperand(rawIn: string): Operand | null {
  const raw = rawIn.trim().replace(/^the\s+/, "").replace(/\s+/g, " ");
  if (raw === "") return null;
  if (NUMBER_RE.test(raw)) return { kind: "NUMBER", value: Number(raw) };

  const pctMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) return { kind: "NUMBER", value: Number(pctMatch[1]) / 100 };

  const indicator = parseIndicator(raw);
  if (indicator) return { kind: "INDICATOR", ref: indicator };
  return null;
}

function parseIndicator(rawIn: string): IndicatorRef | null {
  const raw = rawIn.replace(/-/g, " ").replace(/\s+/g, " ").trim();

  // RSI(14), rsi 14, "14 period rsi", "the rsi"
  const rsi = raw.match(/(?:^|\s)rsi(?:\s*\(\s*(\d+)\s*\)|\s+(\d+))?/);
  if (rsi) {
    const period = Number(rsi[1] ?? rsi[2] ?? 14);
    return { kind: "RSI", period: Number.isFinite(period) ? period : 14 };
  }

  // MACD histogram / line / signal
  if (/macd\s*hist(ogram)?/.test(raw)) return { kind: "MACD_HIST" };
  if (/macd\s*signal/.test(raw)) return { kind: "MACD_SIGNAL" };
  if (/(macd\s*line|^macd$|\bmacd\b)/.test(raw)) return { kind: "MACD_LINE" };

  // EMA(20), 20-day ema, ema 20
  const ema = raw.match(
    /(?:(\d+)[\s-]*(?:day|bar|period)?\s*ema|ema\s*\(?\s*(\d+)\s*\)?|ema\s+(\d+))/,
  );
  if (ema) {
    const period = Number(ema[1] ?? ema[2] ?? ema[3]);
    return { kind: "EMA", period };
  }
  // Bare "ema" without a number → 20.
  if (/\bema\b/.test(raw)) return { kind: "EMA", period: 20 };

  // SMA(50), 50-day sma, sma 50, "200 day moving average"
  const sma = raw.match(
    /(?:(\d+)[\s-]*(?:day|bar|period)?\s*(?:sma|moving average)|sma\s*\(?\s*(\d+)\s*\)?)/,
  );
  if (sma) {
    const period = Number(sma[1] ?? sma[2]);
    return { kind: "SMA", period };
  }
  if (/\b(sma|moving average)\b/.test(raw)) return { kind: "SMA", period: 50 };

  // ATR
  const atr = raw.match(/atr(?:\s*\(\s*(\d+)\s*\)|\s+(\d+))?/);
  if (atr) {
    const period = Number(atr[1] ?? atr[2] ?? 14);
    return { kind: "ATR", period: Number.isFinite(period) ? period : 14 };
  }

  // Volume vs average (we don't model Volume directly as a literal scalar,
  // but "volume above 1.5x average" maps to a VOLUME / VOLUME_AVG ref).
  if (/(average\s+volume|volume\s+average|avg\s+volume)/.test(raw)) {
    return { kind: "VOLUME_AVG", period: 20 };
  }
  if (/\bvolume\b/.test(raw)) return { kind: "VOLUME" };

  // Price / close
  if (/(?:^|\s)(price|close)(?:\s|$)/.test(raw)) return { kind: "CLOSE" };

  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Comparator phrase matcher — handles "is above", "drops below", "crosses
// above", ">", "≥", etc. on the joining word(s) between two operands.
// ───────────────────────────────────────────────────────────────────────────
const COMPARATOR_PATTERNS: Array<{ re: RegExp; cmp: Comparator }> = [
  { re: /\bcross(?:es|ed|ing)?\s+(?:above|over)\b/, cmp: "CROSS_ABOVE" },
  { re: /\bcross(?:es|ed|ing)?\s+(?:below|under)\b/, cmp: "CROSS_BELOW" },
  { re: /\bbreaks?\s+(?:above|out\s+above|over)\b/, cmp: "CROSS_ABOVE" },
  { re: /\bbreaks?\s+(?:below|under|down\s+below)\b/, cmp: "CROSS_BELOW" },
  { re: /\bturns?\s+(?:positive|bullish|green)\b/, cmp: "CROSS_ABOVE" },
  { re: /\bturns?\s+(?:negative|bearish|red)\b/, cmp: "CROSS_BELOW" },
  { re: /(?:>=|≥|at\s+least|reaches)/, cmp: ">=" },
  { re: /(?:<=|≤|at\s+most)/, cmp: "<=" },
  {
    re: /(?:>|above|over|greater\s+than|more\s+than|higher\s+than|exceeds|stronger\s+than)/,
    cmp: ">",
  },
  {
    re: /(?:<|below|under|less\s+than|lower\s+than|drops?\s+below|falls?\s+below|weaker\s+than)/,
    cmp: "<",
  },
  { re: /(?:==|equals|equal\s+to|is\s+at)/, cmp: "==" },
];

interface SplitResult {
  left: string;
  right: string;
  cmp: Comparator;
}

function splitOnComparator(text: string): SplitResult | null {
  for (const { re, cmp } of COMPARATOR_PATTERNS) {
    const match = text.match(re);
    if (!match || match.index === undefined) continue;
    const left = text.slice(0, match.index).trim();
    const right = text.slice(match.index + match[0].length).trim();
    if (left.length === 0 || right.length === 0) continue;
    return { left, right, cmp };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// PCT_CHANGE phrases — "drops 5% in 4 hours", "rises 3% in 1 day".
// We rewrite these into a pre-built `PCT_CHANGE` indicator vs a number.
// ───────────────────────────────────────────────────────────────────────────
const PCT_CHANGE_RE =
  /\bprice\s+(drop|drops|drops?ped|fell|falls?|loses?|down|rises?|rose|gains?|jumps?|up|moves?)\s+(\d+(?:\.\d+)?)\s*%(?:\s+(?:in|over)\s+(\d+)\s*(min|mins|minute|minutes|h|hr|hour|hours|day|days|bar|bars))?\b/;

interface PctChangeMatch {
  cond: Condition;
  bars: number;
}

function matchPctChange(phrase: string, intervalMinutes: number): PctChangeMatch | null {
  const m = phrase.match(PCT_CHANGE_RE);
  if (!m) return null;
  const verb = m[1];
  const pct = Number(m[2]) / 100;
  const qty = m[3] ? Number(m[3]) : 1;
  const unit = m[4] ?? "bar";
  const minutesPerUnit = unit.startsWith("min")
    ? 1
    : unit.startsWith("h")
      ? 60
      : unit.startsWith("d")
        ? 60 * 24
        : intervalMinutes;
  const totalMinutes = qty * minutesPerUnit;
  const bars = Math.max(1, Math.round(totalMinutes / Math.max(intervalMinutes, 1)));
  const isDown = /drop|drops?ped|fell|falls?|loses?|down/.test(verb);
  const left: Operand = {
    kind: "INDICATOR",
    ref: { kind: "PCT_CHANGE", lookback: bars },
  };
  const right: Operand = { kind: "NUMBER", value: isDown ? -pct : pct };
  const cmp: Comparator = isDown ? "<=" : ">=";
  return { cond: { left, comparator: cmp, right }, bars };
}

// ───────────────────────────────────────────────────────────────────────────
// Rule extraction.
// We split the prompt into sentences/clauses, find the entry sentence(s) and
// exit sentence(s), then for each clause break on AND/OR and parse each leg
// into a `Condition` via `splitOnComparator` + `parseOperand`.
// ───────────────────────────────────────────────────────────────────────────
const ENTRY_KEYWORDS = ["buy", "long", "go long", "open long", "enter long", "enter when"];
const SHORT_ENTRY_KEYWORDS = ["short", "go short", "sell short", "open short", "enter short"];
const EXIT_KEYWORDS = ["sell", "exit", "close", "take profit when", "tp when"];

function isEntrySentence(s: string): boolean {
  return ENTRY_KEYWORDS.some((k) => s.startsWith(k) || s.includes(` ${k} `));
}

function isShortEntrySentence(s: string): boolean {
  // Avoid false-positive on "sell" — that's an exit verb in this DSL unless
  // the sentence reads like "sell short" or "open short".
  return SHORT_ENTRY_KEYWORDS.some((k) => s.startsWith(k) || s.includes(` ${k} `));
}

function isExitSentence(s: string): boolean {
  return EXIT_KEYWORDS.some((k) => s.includes(k));
}

interface ConditionPiece {
  cond: Condition;
}

function parseClause(
  clause: string,
  intervalMinutes: number,
  warnings: string[],
): { conditions: Condition[]; logic: LogicOp } {
  // Split on AND / OR. Default to AND for top-level joining.
  const lower = clause.toLowerCase().trim();
  const orSplit = splitTopLevel(lower, /\bor\b/g);
  if (orSplit.length > 1) {
    const conds = orSplit
      .flatMap((p) => parseClause(p, intervalMinutes, warnings).conditions)
      .filter(Boolean);
    return { conditions: conds, logic: "OR" };
  }
  const andSplit = splitTopLevel(lower, /\b(?:and|&|plus|while)\b/g);
  if (andSplit.length > 1) {
    const conds: Condition[] = [];
    for (const p of andSplit) {
      const sub = parseSingleCondition(p, intervalMinutes, warnings);
      if (sub) conds.push(sub.cond);
    }
    return { conditions: conds, logic: "AND" };
  }

  const single = parseSingleCondition(clause, intervalMinutes, warnings);
  return {
    conditions: single ? [single.cond] : [],
    logic: "AND",
  };
}

function splitTopLevel(text: string, re: RegExp): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue;
    parts.push(text.slice(last, match.index).trim());
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last).trim());
  return parts.filter((p) => p.length > 0);
}

function parseSingleCondition(
  clause: string,
  intervalMinutes: number,
  warnings: string[],
): ConditionPiece | null {
  const stripped = clause
    .replace(/^(?:buy|long|enter|go\s+long|open\s+long|sell|short|exit|close)\s+(?:when\s+|if\s+)?/, "")
    .trim();
  if (!stripped) return null;

  // PCT_CHANGE shortcut. Run against the un-cleaned phrase so we don't
  // accidentally strip the "in" / "over" duration connector before the
  // regex sees it.
  const pct = matchPctChange(stripped, intervalMinutes);
  if (pct) return { cond: pct.cond };

  // Now drop filler words for everything else. We deliberately do NOT
  // strip "in" / "over" here because those have already been consumed by
  // the percent-change matcher above.
  const cleaned = stripped.replace(/\s+(?:the|that|whenever)\s+/g, " ").trim();

  // Volume above 1.5x average → VOLUME > 1.5 * VOLUME_AVG. We compress to
  // VOLUME / VOLUME_AVG > 1.5 by encoding both refs and asking the engine
  // to compute the ratio at evaluation time.
  const volSpike = cleaned.match(/volume\s+(?:above|over|greater than)\s+(\d+(?:\.\d+)?)\s*x?\s*(?:average|avg)?/);
  if (volSpike) {
    const mult = Number(volSpike[1]);
    return {
      cond: {
        left: { kind: "INDICATOR", ref: { kind: "VOLUME" } },
        comparator: ">",
        right: { kind: "NUMBER", value: mult },
      },
    };
  }

  // "MACD histogram turns positive/negative" — already covered by comparator
  // patterns ("turns positive" → CROSS_ABOVE 0). We rewrite to "macd
  // histogram crosses above 0".
  const macdTurn = cleaned.match(/macd\s*hist(?:ogram)?\s+turns\s+(positive|negative|bullish|bearish|green|red)/);
  if (macdTurn) {
    const positive = /positive|bullish|green/.test(macdTurn[1]);
    return {
      cond: {
        left: { kind: "INDICATOR", ref: { kind: "MACD_HIST" } },
        comparator: positive ? "CROSS_ABOVE" : "CROSS_BELOW",
        right: { kind: "NUMBER", value: 0 },
      },
    };
  }

  const split = splitOnComparator(cleaned);
  if (!split) {
    warnings.push(`Couldn't parse condition: "${cleaned}".`);
    return null;
  }

  // For percent literals like "30" in "RSI < 30", we leave them as a raw
  // number — RSI is already on a 0–100 scale.
  let right = parseOperand(split.right);
  const left = parseOperand(split.left);

  // "price drops 5% in 4 hours" already handled. Accept "moves N%" without
  // an explicit duration → assume current bar PCT_CHANGE(1).
  if (!left || !right) {
    warnings.push(`Couldn't resolve operands in: "${cleaned}".`);
    return null;
  }

  // Special-case: if comparator is CROSS_ABOVE/BELOW and right side is a
  // percent (e.g. "RSI crosses above 70%"), strip the % so RSI levels work.
  if (right.kind === "NUMBER" && /(?:rsi)/.test(split.left) && right.value <= 1) {
    right = { kind: "NUMBER", value: right.value * 100 };
  }

  return { cond: { left, comparator: split.cmp, right } };
}

// ───────────────────────────────────────────────────────────────────────────
// Risk extraction.
// ───────────────────────────────────────────────────────────────────────────
function extractRisk(prompt: string, warnings: string[]): RiskParams {
  const out: RiskParams = {};

  const slPct = prompt.match(/stop(?:\s*loss)?\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%/);
  if (slPct) out.stopLossPct = Number(slPct[1]) / 100;
  const tpPct = prompt.match(/(?:take\s*profit|target|tp)\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*%/);
  if (tpPct) out.takeProfitPct = Number(tpPct[1]) / 100;

  const slAtr = prompt.match(/stop(?:\s*loss)?\s+(\d+(?:\.\d+)?)\s*x\s*atr/);
  if (slAtr) out.stopAtrMult = Number(slAtr[1]);
  const tpAtr = prompt.match(/(?:take\s*profit|target|tp)\s+(\d+(?:\.\d+)?)\s*x\s*atr/);
  if (tpAtr) out.targetAtrMult = Number(tpAtr[1]);

  const hold = prompt.match(/(?:exit|close|sell)\s+(?:after|in)\s+(\d+)\s*(min|mins|minute|minutes|h|hr|hour|hours|day|days|bar|bars)/);
  if (hold) {
    const qty = Number(hold[1]);
    const unit = hold[2];
    const minutesPerUnit = unit.startsWith("min")
      ? 1
      : unit.startsWith("h")
        ? 60
        : unit.startsWith("d")
          ? 60 * 24
          : 1;
    out.maxHoldBars = Math.max(1, Math.round((qty * minutesPerUnit) / 1));
  }

  if (out.stopAtrMult && out.stopLossPct) {
    warnings.push("Both ATR-based and % stop-loss specified — using % stop.");
  }
  return out;
}

function extractNotional(prompt: string): number {
  const m = prompt.match(/(?:risk|trade|use|invest|notional|size)\s+\$?(\d+(?:\.\d+)?)\s*(?:k|usd|dollars)?(?:\s*per\s*trade)?/);
  if (!m) return 1000;
  const raw = Number(m[1]);
  const k = /\bk\b/.test(m[0]);
  return k ? raw * 1000 : raw;
}

// ───────────────────────────────────────────────────────────────────────────
// Entry point.
// ───────────────────────────────────────────────────────────────────────────
export interface ParseOptions {
  /** Bar interval minutes — used to convert "5% in 4 hours" → bars. */
  intervalMinutes?: number;
}

export function parseStrategy(promptIn: string, opts: ParseOptions = {}): ParsedStrategy {
  const intervalMinutes = opts.intervalMinutes ?? 60;
  const prompt = normalize(promptIn);
  const warnings: string[] = [];
  if (!prompt) {
    return {
      prompt: "",
      side: "LONG",
      entry: { conditions: [], logic: "AND" },
      exit: null,
      risk: {},
      notional: 1000,
      summary: [],
      warnings: ["Empty strategy."],
    };
  }

  // Split into clauses on "." (after periods) and on " and then ".
  const sentences = prompt
    .split(/(?:\.\s+|;\s+|\s+then\s+)/)
    .map((s) => s.trim())
    .filter(Boolean);

  let entrySentence = "";
  let exitSentence = "";
  let isShort = false;

  for (const s of sentences) {
    if (!entrySentence && (isEntrySentence(s) || isShortEntrySentence(s))) {
      entrySentence = s;
      if (isShortEntrySentence(s) && !isEntrySentence(s)) isShort = true;
    } else if (!exitSentence && isExitSentence(s)) {
      // Don't reuse the same sentence if it already serves as entry+exit (e.g.
      // "Buy when RSI < 30 and sell when RSI > 70" lives in one sentence —
      // we'll handle that path below by re-scanning the entry sentence.).
      exitSentence = s;
    }
  }

  // If there was no separator at all, fall back to the full prompt as the
  // entry sentence and try to split on the first " and sell " / " and exit ".
  if (!entrySentence) entrySentence = prompt;
  if (!exitSentence) {
    const inline = entrySentence.match(/^(.*?)\s+and\s+(?:sell|exit|close)\s+(?:when\s+)?(.*)$/);
    if (inline) {
      entrySentence = inline[1];
      exitSentence = `sell when ${inline[2]}`;
    }
  }

  const side: Side = isShort ? "SHORT" : "LONG";
  const entryRule: Rule = parseClause(entrySentence, intervalMinutes, warnings);
  const exitRule: Rule | null = exitSentence
    ? parseClause(exitSentence, intervalMinutes, warnings)
    : null;

  if (entryRule.conditions.length === 0) {
    warnings.push(
      "No entry conditions detected. Try: \"Buy when RSI drops below 30\".",
    );
  }

  const risk = extractRisk(prompt, warnings);
  const notional = extractNotional(prompt);

  const summary = buildSummary({
    side,
    entry: entryRule,
    exit: exitRule,
    risk,
    notional,
  });

  return {
    prompt,
    side,
    entry: entryRule,
    exit: exitRule && exitRule.conditions.length > 0 ? exitRule : null,
    risk,
    notional,
    summary,
    warnings,
  };
}

function buildSummary(s: {
  side: Side;
  entry: Rule;
  exit: Rule | null;
  risk: RiskParams;
  notional: number;
}): string[] {
  const out: string[] = [];
  out.push(`Open ${s.side} when ${describeRule(s.entry)}.`);
  if (s.exit) out.push(`Close when ${describeRule(s.exit)}.`);
  if (s.risk.stopLossPct) out.push(`Stop loss at ${(s.risk.stopLossPct * 100).toFixed(2)}%.`);
  else if (s.risk.stopAtrMult) out.push(`Stop loss at ${s.risk.stopAtrMult}× ATR(14).`);
  if (s.risk.takeProfitPct) out.push(`Take profit at ${(s.risk.takeProfitPct * 100).toFixed(2)}%.`);
  else if (s.risk.targetAtrMult) out.push(`Take profit at ${s.risk.targetAtrMult}× ATR(14).`);
  if (s.risk.maxHoldBars) out.push(`Max hold ${s.risk.maxHoldBars} bars.`);
  out.push(`Notional per trade: $${s.notional.toFixed(0)}.`);
  return out;
}

function describeRule(rule: Rule): string {
  return rule.conditions
    .map(describeCondition)
    .join(rule.logic === "OR" ? " OR " : " AND ");
}

function describeCondition(c: Condition): string {
  return `${describeOperand(c.left)} ${describeComparator(c.comparator)} ${describeOperand(c.right)}`;
}

function describeOperand(o: Operand): string {
  if (o.kind === "NUMBER") {
    if (Math.abs(o.value) < 1 && Math.abs(o.value) > 0) return `${(o.value * 100).toFixed(2)}%`;
    return o.value.toString();
  }
  return describeRef(o.ref);
}

function describeRef(ref: IndicatorRef): string {
  switch (ref.kind) {
    case "RSI":
      return `RSI(${ref.period ?? 14})`;
    case "MACD_LINE":
      return "MACD line";
    case "MACD_SIGNAL":
      return "MACD signal";
    case "MACD_HIST":
      return "MACD histogram";
    case "EMA":
      return `EMA(${ref.period ?? 20})`;
    case "SMA":
      return `SMA(${ref.period ?? 50})`;
    case "ATR":
      return `ATR(${ref.period ?? 14})`;
    case "VOLUME":
      return "volume / avg volume";
    case "VOLUME_AVG":
      return `avg volume(${ref.period ?? 20})`;
    case "PCT_CHANGE":
      return `% change (${ref.lookback ?? 1} bars)`;
    case "PRICE":
    case "CLOSE":
    default:
      return "price";
  }
}

function describeComparator(c: Comparator): string {
  switch (c) {
    case ">":
      return "is above";
    case ">=":
      return "is at or above";
    case "<":
      return "is below";
    case "<=":
      return "is at or below";
    case "==":
      return "equals";
    case "CROSS_ABOVE":
      return "crosses above";
    case "CROSS_BELOW":
      return "crosses below";
  }
}
