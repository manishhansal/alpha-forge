import "server-only";

import { Prisma } from "@prisma/client";

import {
  decrypt,
  encrypt,
  encryptionAvailable,
  type EncryptedPayload,
} from "@/lib/crypto";
import { getPrisma } from "@/lib/prisma";

// Re-export the client-safe constants and types so existing server-side
// consumers (and tests) can keep importing from `@/features/settings/api-keys`.
// The client form imports them directly from `./api-keys-shared` to avoid
// pulling this module's server-only deps into the browser bundle.
export {
  DELETE_INPUT_SCHEMA,
  EXCHANGE_LABELS,
  SAVE_INPUT_SCHEMA,
  SUPPORTED_EXCHANGES,
  type Exchange,
  type SaveApiKeyInput,
  type StoredKeySummary,
} from "./api-keys-shared";
import {
  SUPPORTED_EXCHANGES,
  usesSmartApiAuth,
  type Exchange,
  type SaveApiKeyInput,
  type StoredKeySummary,
} from "./api-keys-shared";

interface StoredKeyEntry {
  /** Encrypted API key (the "public" half on most exchanges). */
  apiKey: EncryptedPayload;
  /** Encrypted API secret (the "private" half). Absent for SmartAPI logins. */
  apiSecret?: EncryptedPayload;
  /** Encrypted Angel One SmartAPI login triplet (SmartAPI exchanges only). */
  clientCode?: EncryptedPayload;
  pin?: EncryptedPayload;
  totpSecret?: EncryptedPayload;
  /** Marker set by the user at save time. */
  readOnly: boolean;
  /** Last write time (ISO). Mirrors apiKey.ts for convenience. */
  updatedAt: string;
}

type StoredKeyMap = Partial<Record<Exchange, StoredKeyEntry>>;

function parseStored(raw: Prisma.JsonValue | null | undefined): StoredKeyMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // We trust shape on read because we control the writer; decrypt() will
  // throw on malformed payloads anyway and the catch site reports it.
  return raw as unknown as StoredKeyMap;
}

function previewFrom(plaintextKey: string): string {
  const clean = plaintextKey.replace(/\s+/gu, "");
  if (clean.length <= 4) return clean;
  return clean.slice(-4);
}

/**
 * Returns redacted summaries for every exchange the user has saved a key for.
 * Decrypts each row server-side to produce a last-4-chars preview; if a key
 * can't be decrypted (e.g. ENCRYPTION_KEY was rotated) we surface the row
 * with an empty preview so the user can rotate or delete it.
 */
export async function listStoredKeys(userId: string): Promise<StoredKeySummary[]> {
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const stored = parseStored(row?.apiKeysEncrypted);

  const out: StoredKeySummary[] = [];
  for (const ex of SUPPORTED_EXCHANGES) {
    const entry = stored[ex];
    if (!entry) continue;
    let preview = "";
    try {
      preview = previewFrom(decrypt(entry.apiKey));
    } catch (err) {
      console.warn(`[api-keys] failed to decrypt ${ex} key:`, (err as Error).message);
    }
    out.push({
      exchange: ex,
      keyPreview: preview,
      updatedAt: entry.updatedAt,
      readOnly: entry.readOnly,
    });
  }
  return out;
}

async function writeStoredMap(userId: string, next: StoredKeyMap): Promise<void> {
  const prisma = getPrisma();
  const value =
    Object.keys(next).length === 0
      ? Prisma.DbNull
      : (next as unknown as Prisma.InputJsonValue);
  await prisma.userSetting.upsert({
    where: { userId },
    create: { userId, apiKeysEncrypted: value },
    update: { apiKeysEncrypted: value },
  });
}

/**
 * Save (or replace) one exchange's API key + secret. The plaintexts only
 * leave the form action's scope long enough to be encrypted — they're never
 * logged and never written to the database in plaintext.
 */
export async function saveApiKey(userId: string, input: SaveApiKeyInput): Promise<void> {
  if (!encryptionAvailable()) {
    throw new Error(
      "Server is missing ENCRYPTION_KEY. Generate one with `openssl rand -hex 32` and add it to .env.local.",
    );
  }
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const current = parseStored(row?.apiKeysEncrypted);

  const entry: StoredKeyEntry = {
    apiKey: encrypt(input.apiKey),
    readOnly: input.readOnly,
    updatedAt: new Date().toISOString(),
  };
  if (usesSmartApiAuth(input.exchange)) {
    // Angel One SmartAPI: store the broker login triplet, not an apiSecret.
    entry.clientCode = encrypt(input.clientCode);
    entry.pin = encrypt(input.pin);
    entry.totpSecret = encrypt(input.totpSecret);
  } else {
    entry.apiSecret = encrypt(input.apiSecret);
  }
  await writeStoredMap(userId, { ...current, [input.exchange]: entry });
}

export async function deleteApiKey(userId: string, exchange: Exchange): Promise<void> {
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const current = parseStored(row?.apiKeysEncrypted);
  if (!current[exchange]) return;
  const next: StoredKeyMap = { ...current };
  delete next[exchange];
  await writeStoredMap(userId, next);
}

/**
 * Internal helper for any future feature that needs to consume a stored key
 * (account balance import, place private order, etc.). Returns plaintext —
 * never expose the return value to the client. Throws if the row is missing
 * or the ciphertext can't be decrypted (e.g. ENCRYPTION_KEY was rotated).
 */
export async function readApiKey(
  userId: string,
  exchange: Exchange,
): Promise<{ apiKey: string; apiSecret: string; readOnly: boolean } | null> {
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const stored = parseStored(row?.apiKeysEncrypted);
  const entry = stored[exchange];
  if (!entry) return null;
  return {
    apiKey: decrypt(entry.apiKey),
    apiSecret: entry.apiSecret ? decrypt(entry.apiSecret) : "",
    readOnly: entry.readOnly,
  };
}

/** Plaintext Angel One SmartAPI credential set for a user. Returns `null`
 *  when no Angel One key is stored or the stored entry is incomplete. Never
 *  expose the return value to the client. */
export interface AngelStoredCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

export async function readAngelCredentials(
  userId: string,
): Promise<AngelStoredCredentials | null> {
  const prisma = getPrisma();
  const row = await prisma.userSetting.findUnique({
    where: { userId },
    select: { apiKeysEncrypted: true },
  });
  const entry = parseStored(row?.apiKeysEncrypted).angel;
  if (!entry || !entry.clientCode || !entry.pin || !entry.totpSecret) return null;
  try {
    return {
      apiKey: decrypt(entry.apiKey),
      clientCode: decrypt(entry.clientCode),
      pin: decrypt(entry.pin),
      totpSecret: decrypt(entry.totpSecret),
    };
  } catch (err) {
    console.warn(`[api-keys] failed to decrypt Angel One creds:`, (err as Error).message);
    return null;
  }
}
