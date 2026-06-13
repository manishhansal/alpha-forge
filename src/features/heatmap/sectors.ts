/**
 * Curated sector membership for the heatmap. Each entry maps a Binance USDT
 * perpetual to a logical sector. We deliberately keep this list small so the
 * grid stays readable; expansion is a one-line addition.
 *
 * Symbols not present in this map are bucketed into `Other` and excluded from
 * sector aggregates so the macro view isn't polluted by long-tail noise.
 */

export type Sector = "L1" | "L2" | "DeFi" | "Meme" | "AI" | "Infra" | "Other";

export const SECTOR_LABEL: Record<Sector, string> = {
  L1: "Layer 1",
  L2: "Layer 2",
  DeFi: "DeFi",
  Meme: "Meme",
  AI: "AI",
  Infra: "Infrastructure",
  Other: "Other",
};

/** Stable display order, top-to-bottom in the sector strip. */
export const SECTOR_ORDER: readonly Sector[] = ["L1", "L2", "DeFi", "AI", "Infra", "Meme"] as const;

const SECTOR_MAP: Record<string, Sector> = {
  // Layer 1
  BTCUSDT: "L1",
  ETHUSDT: "L1",
  SOLUSDT: "L1",
  BNBUSDT: "L1",
  ADAUSDT: "L1",
  AVAXUSDT: "L1",
  TRXUSDT: "L1",
  DOTUSDT: "L1",
  ATOMUSDT: "L1",
  NEARUSDT: "L1",
  APTUSDT: "L1",
  SUIUSDT: "L1",
  TONUSDT: "L1",
  XRPUSDT: "L1",
  // Layer 2
  ARBUSDT: "L2",
  OPUSDT: "L2",
  MATICUSDT: "L2",
  POLUSDT: "L2",
  STRKUSDT: "L2",
  ZKUSDT: "L2",
  MANTAUSDT: "L2",
  METISUSDT: "L2",
  // DeFi
  UNIUSDT: "DeFi",
  AAVEUSDT: "DeFi",
  MKRUSDT: "DeFi",
  COMPUSDT: "DeFi",
  LDOUSDT: "DeFi",
  CRVUSDT: "DeFi",
  SNXUSDT: "DeFi",
  DYDXUSDT: "DeFi",
  GMXUSDT: "DeFi",
  SUSHIUSDT: "DeFi",
  // AI / data
  FETUSDT: "AI",
  AGIXUSDT: "AI",
  RNDRUSDT: "AI",
  RENDERUSDT: "AI",
  TAOUSDT: "AI",
  WLDUSDT: "AI",
  AKTUSDT: "AI",
  // Infra / oracles / interop
  LINKUSDT: "Infra",
  GRTUSDT: "Infra",
  FILUSDT: "Infra",
  ARUSDT: "Infra",
  RUNEUSDT: "Infra",
  INJUSDT: "Infra",
  TIAUSDT: "Infra",
  SEIUSDT: "Infra",
  // Meme
  DOGEUSDT: "Meme",
  SHIBUSDT: "Meme",
  PEPEUSDT: "Meme",
  WIFUSDT: "Meme",
  BONKUSDT: "Meme",
  FLOKIUSDT: "Meme",
  MEMEUSDT: "Meme",
  "1000PEPEUSDT": "Meme",
  "1000SHIBUSDT": "Meme",
  "1000BONKUSDT": "Meme",
  "1000FLOKIUSDT": "Meme",
};

export function sectorFor(pair: string): Sector {
  // Both `BTCUSDT` (Binance) and `BTCUSD` (Delta India) are valid inputs;
  // try the raw key first, then a USDT-normalised lookup so the sector map
  // doesn't need a duplicate row per quote currency.
  if (SECTOR_MAP[pair]) return SECTOR_MAP[pair];
  if (pair.endsWith("USD")) {
    const alt = `${pair}T`;
    if (SECTOR_MAP[alt]) return SECTOR_MAP[alt];
  }
  return "Other";
}

/** Strip the `USDT` / `USD` suffix and a `1000` price-scale prefix for display. */
export function prettySymbol(pair: string): string {
  const trimmed = pair.replace(/USDT$/u, "").replace(/USD$/u, "");
  return trimmed.replace(/^1000/, "");
}
