/**
 * Client-safe constants and types for the exchange API-keys feature.
 *
 * Everything here is plain data + pure zod schemas — no Prisma, no crypto, no
 * `server-only`. The server-side implementation lives in `./api-keys.ts` and
 * re-exports these so existing server callers keep working.
 */

import { z } from "zod";

export const SUPPORTED_EXCHANGES = [
  // Crypto
  "binance",
  "delta",
  "bybit",
  "deribit",
  // India
  "groww",
  "zerodha",
  "angel",
] as const;
export type Exchange = (typeof SUPPORTED_EXCHANGES)[number];

export const EXCHANGE_LABELS: Record<Exchange, string> = {
  binance: "Binance",
  delta: "Delta Exchange India",
  bybit: "Bybit",
  deribit: "Deribit",
  groww: "Groww",
  zerodha: "Zerodha Kite",
  angel: "Angel One SmartAPI",
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
  angel: "india",
};

/**
 * Angel One's SmartAPI doesn't use the standard `apiKey` + `apiSecret` pair.
 * Instead it needs the SmartAPI key plus the broker login triplet
 * (client code + MPIN + TOTP secret). Exchanges in this set render the
 * dedicated credential fields in the API-keys form and validate against the
 * Angel One branch of {@link SAVE_INPUT_SCHEMA}.
 */
export const SMARTAPI_EXCHANGES = ["angel"] as const;

export function usesSmartApiAuth(exchange: Exchange): boolean {
  return (SMARTAPI_EXCHANGES as readonly string[]).includes(exchange);
}

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

/* ───────────────── Validation schemas (shared client + server) ───────────────── */

/**
 * Validates the API-keys "save" form. The shape is uniform (so the form can
 * post a single FormData blob) but the requirements branch by exchange:
 *   - SmartAPI exchanges (Angel One) need `clientCode` + `pin` + `totpSecret`
 *     and ignore `apiSecret`.
 *   - Every other exchange needs the classic `apiKey` + `apiSecret` pair.
 */
export const SAVE_INPUT_SCHEMA = z
  .object({
    exchange: z.enum(SUPPORTED_EXCHANGES),
    apiKey: z
      .string()
      .trim()
      .min(8, "API key looks too short")
      .max(256, "API key looks too long"),
    apiSecret: z.string().trim().max(512, "API secret looks too long").optional().default(""),
    clientCode: z.string().trim().max(64, "Client code looks too long").optional().default(""),
    pin: z.string().trim().max(64, "PIN looks too long").optional().default(""),
    totpSecret: z.string().trim().max(128, "TOTP secret looks too long").optional().default(""),
    readOnly: z.boolean().optional().default(true),
  })
  .superRefine((val, ctx) => {
    if (usesSmartApiAuth(val.exchange)) {
      if (val.clientCode.length < 3) {
        ctx.addIssue({ code: "custom", path: ["clientCode"], message: "Client code is required" });
      }
      if (val.pin.length < 4) {
        ctx.addIssue({ code: "custom", path: ["pin"], message: "PIN must be at least 4 characters" });
      }
      if (val.totpSecret.length < 8) {
        ctx.addIssue({
          code: "custom",
          path: ["totpSecret"],
          message: "TOTP secret is required (the base32 string from 2FA setup)",
        });
      }
    } else if (val.apiSecret.length < 8) {
      ctx.addIssue({ code: "custom", path: ["apiSecret"], message: "API secret looks too short" });
    }
  });

export const DELETE_INPUT_SCHEMA = z.object({
  exchange: z.enum(SUPPORTED_EXCHANGES),
});

export type SaveApiKeyInput = z.infer<typeof SAVE_INPUT_SCHEMA>;
