/**
 * Client-safe constants and types for the exchange API-keys feature.
 *
 * Everything here is plain data — no Prisma, no crypto, no `server-only`.
 * The server-side implementation lives in `./api-keys.ts` and re-exports
 * these so existing server callers keep working.
 */

export const SUPPORTED_EXCHANGES = [
  // Crypto
  "binance",
  "delta",
  "bybit",
  "deribit",
  // India
  "groww",
  "zerodha",
] as const;
export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

export const EXCHANGE_LABELS: Record<Exchange, string> = {
  binance: "Binance",
  delta: "Delta Exchange India",
  bybit: "Bybit",
  deribit: "Deribit",
  groww: "Groww",
  zerodha: "Zerodha Kite",
};

/** Which market surface a stored credential belongs to. Drives the
 *  "Crypto" vs "India" grouping in the API keys card. */
export const EXCHANGE_MARKET: Record<Exchange, "crypto" | "india"> = {
  binance: "crypto",
  delta: "crypto",
  bybit: "crypto",
  deribit: "crypto",
  groww: "india",
  zerodha: "india",
};

/** Public, redacted view of one exchange's stored credentials. */
export interface StoredKeySummary {
  exchange: Exchange;
  /** Last 4 chars of the API key (decrypted server-side); empty if N/A. */
  keyPreview: string;
  /** ISO timestamp the ciphertext was last written. */
  updatedAt: string;
  /** Optional read-only flag set when the user originally saved the key. */
  readOnly: boolean;
}
