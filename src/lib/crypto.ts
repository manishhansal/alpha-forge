import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // recommended for GCM
const TAG_BYTES = 16;

export interface EncryptedPayload {
  /** 24 hex chars (12 bytes) — random IV unique per encryption. */
  iv: string;
  /** 32 hex chars (16 bytes) — GCM auth tag. */
  tag: string;
  /** hex ciphertext. */
  ct: string;
  /** ISO timestamp for audit / rotation. */
  ts: string;
}

function getKey(): Buffer {
  if (!env.ENCRYPTION_KEY) {
    throw new Error(
      "[crypto] ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env.local.",
    );
  }
  const key = Buffer.from(env.ENCRYPTION_KEY, "hex");
  if (key.length !== 32) {
    throw new Error("[crypto] ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars).");
  }
  return key;
}

export function encrypt(plaintext: string): EncryptedPayload {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ct: ct.toString("hex"),
    ts: new Date().toISOString(),
  };
}

export function decrypt(payload: EncryptedPayload): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("[crypto] malformed encrypted payload (iv/tag length)");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(payload.ct, "hex")), decipher.final()]);
  return pt.toString("utf8");
}

/** True when ENCRYPTION_KEY is configured. Use this in UI to gate API-key fields. */
export function encryptionAvailable(): boolean {
  return Boolean(env.ENCRYPTION_KEY);
}
