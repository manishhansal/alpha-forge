import { describe, expect, it, vi } from "vitest";

// `lib/env.ts` only includes ENCRYPTION_KEY in the server schema, but the
// jsdom test environment defines `window` so env.ts falls back to the
// client schema (which has no ENCRYPTION_KEY field). Mock `@/lib/env` so
// the crypto module can read the test key.
vi.mock("@/lib/env", () => ({
  env: {
    ENCRYPTION_KEY:
      "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    NODE_ENV: "test",
  },
}));

import { decrypt, encrypt, encryptionAvailable } from "@/lib/crypto";

describe("lib/crypto (AES-256-GCM)", () => {
  it("encryptionAvailable() reports true when ENCRYPTION_KEY is set", () => {
    expect(encryptionAvailable()).toBe(true);
  });

  it("encrypts and decrypts a simple ASCII string round-trip", () => {
    const payload = encrypt("hello-world");
    expect(payload.iv).toMatch(/^[0-9a-f]{24}$/u);
    expect(payload.tag).toMatch(/^[0-9a-f]{32}$/u);
    expect(payload.ct).toMatch(/^[0-9a-f]+$/u);
    expect(decrypt(payload)).toBe("hello-world");
  });

  it("round-trips Unicode and longer payloads", () => {
    const text = "🚀  multi-byte payload — Δ ✓ 你好";
    expect(decrypt(encrypt(text))).toBe(text);

    const long = "x".repeat(4096);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  it("uses a fresh IV on every encryption", () => {
    const a = encrypt("same-plaintext");
    const b = encrypt("same-plaintext");
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ct).not.toEqual(b.ct);
  });

  it("throws when the auth tag has been tampered with", () => {
    const payload = encrypt("integrity-protected");
    // Flip a single hex digit of the tag — auth-check must fail.
    const corrupted = {
      ...payload,
      tag: payload.tag.replace(/^./u, (c) => (c === "0" ? "f" : "0")),
    };
    expect(() => decrypt(corrupted)).toThrow();
  });

  it("throws when the IV length is wrong", () => {
    const payload = encrypt("foo");
    expect(() =>
      decrypt({
        ...payload,
        iv: "00", // 1 byte — invalid for AES-GCM
      }),
    ).toThrow(/iv|tag/i);
  });

  it("throws when the tag length is wrong", () => {
    const payload = encrypt("foo");
    expect(() =>
      decrypt({
        ...payload,
        tag: "0011",
      }),
    ).toThrow(/iv|tag/i);
  });

  it("attaches a sortable ISO timestamp to every payload", () => {
    const payload = encrypt("stamped");
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});
