/**
 * Angel One SmartAPI account-data parsers (read-only).
 *
 * Normalises the broker's funds/margin (RMS), holdings and positions payloads
 * — whose numeric fields ship as strings (sometimes space-prefixed for signed
 * values, e.g. `"- 4471.60"`) — into clean, number-typed shapes. Pure +
 * unit-tested; the adapter layer handles auth, caching and HTTP.
 *
 * These power a read-only "broker account" surface alongside Paper Trading.
 * Live order placement is intentionally NOT implemented here.
 */

/** Coerce a SmartAPI string|number money field to a finite number or null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/\s+/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ── Funds / margin (getRMS) ─────────────────────────────────────────────────

export type AccountFunds = {
  /** Net available balance. */
  net: number | null;
  availableCash: number | null;
  availableIntradayPayin: number | null;
  availableLimitMargin: number | null;
  collateral: number | null;
  m2mUnrealized: number | null;
  m2mRealized: number | null;
  utilisedDebits: number | null;
};

export function parseFunds(raw: unknown): AccountFunds {
  const r = isRecord(raw) ? raw : {};
  return {
    net: num(r.net),
    availableCash: num(r.availablecash),
    availableIntradayPayin: num(r.availableintradaypayin),
    availableLimitMargin: num(r.availablelimitmargin),
    collateral: num(r.collateral),
    m2mUnrealized: num(r.m2munrealized),
    m2mRealized: num(r.m2mrealized),
    utilisedDebits: num(r.utiliseddebits),
  };
}

// ── Holdings (getAllHolding / getHolding) ───────────────────────────────────

export type Holding = {
  symbol: string;
  token: string | null;
  exchange: string | null;
  product: string | null;
  quantity: number | null;
  averagePrice: number | null;
  ltp: number | null;
  close: number | null;
  pnl: number | null;
  pnlPct: number | null;
};

export type HoldingsSummary = {
  totalValue: number | null;
  totalInvestment: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
};

export type HoldingsResult = {
  holdings: Holding[];
  summary: HoldingsSummary | null;
};

function parseHolding(raw: unknown): Holding | null {
  if (!isRecord(raw)) return null;
  const symbol = str(raw.tradingsymbol);
  if (!symbol) return null;
  return {
    symbol,
    token: str(raw.symboltoken),
    exchange: str(raw.exchange),
    product: str(raw.product),
    quantity: num(raw.quantity),
    averagePrice: num(raw.averageprice),
    ltp: num(raw.ltp),
    close: num(raw.close),
    pnl: num(raw.profitandloss),
    pnlPct: num(raw.pnlpercentage),
  };
}

export function parseHoldings(raw: unknown): HoldingsResult {
  // Newer getAllHolding: { holdings: [...], totalholding: {...} }.
  // Legacy getHolding: a bare array.
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.holdings)
      ? raw.holdings
      : [];
  const holdings = list
    .map(parseHolding)
    .filter((h): h is Holding => h !== null);

  let summary: HoldingsSummary | null = null;
  if (isRecord(raw) && isRecord(raw.totalholding)) {
    const t = raw.totalholding;
    summary = {
      totalValue: num(t.totalholdingvalue),
      totalInvestment: num(t.totalinvvalue),
      totalPnl: num(t.totalprofitandloss),
      totalPnlPct: num(t.totalpnlpercentage),
    };
  }
  return { holdings, summary };
}

// ── Positions (getPosition) ─────────────────────────────────────────────────

export type Position = {
  symbol: string;
  name: string | null;
  token: string | null;
  exchange: string | null;
  productType: string | null;
  netQty: number | null;
  buyQty: number | null;
  sellQty: number | null;
  buyAvgPrice: number | null;
  sellAvgPrice: number | null;
  avgNetPrice: number | null;
  ltp: number | null;
  pnl: number | null;
};

function parsePosition(raw: unknown): Position | null {
  if (!isRecord(raw)) return null;
  const symbol = str(raw.tradingsymbol);
  if (!symbol) return null;
  return {
    symbol,
    name: str(raw.symbolname),
    token: str(raw.symboltoken),
    exchange: str(raw.exchange),
    productType: str(raw.producttype),
    netQty: num(raw.netqty),
    buyQty: num(raw.buyqty),
    sellQty: num(raw.sellqty),
    buyAvgPrice: num(raw.buyavgprice),
    sellAvgPrice: num(raw.sellavgprice),
    avgNetPrice: num(raw.avgnetprice),
    ltp: num(raw.ltp),
    pnl: num(raw.pnl),
  };
}

export function parsePositions(raw: unknown): Position[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parsePosition).filter((p): p is Position => p !== null);
}
