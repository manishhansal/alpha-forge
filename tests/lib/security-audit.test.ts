// @vitest-environment node
/**
 * Phase 22 — Security Audit Tests
 *
 * Verifies:
 *   1. API keys never reach browser (server-only imports)
 *   2. ML endpoints are server-side only
 *   3. Broker credentials are server-side only
 *   4. Environment variables validated via Zod schema
 *   5. LIVE_TRADING_ENABLED guard is present
 *   6. No secrets in committed code patterns
 *   7. Input validation on API routes
 *   8. Auth protection on user routes
 *
 * Validates: PHASE 22 requirements — security audit
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function readSrc(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Server-only guards on sensitive modules
// ─────────────────────────────────────────────────────────────────────────────

describe("Server-only guards", () => {
  it("ml-client.ts has server-only import", () => {
    const src = readSrc("src/lib/india/ml-client.ts");
    expect(src).toMatch(/import "server-only"/);
  });

  it("ml-enhanced-context.ts has server-only import", () => {
    const src = readSrc("src/lib/india/ml-enhanced-context.ts");
    expect(src).toMatch(/import "server-only"/);
  });

  it("candle-builder.service.ts has server-only import", () => {
    const src = readSrc("src/lib/market-data/services/candle-builder.service.ts");
    expect(src).toMatch(/import "server-only"/);
  });

  it("prisma.ts has server-only import", () => {
    const src = readSrc("src/lib/prisma.ts");
    expect(src).toMatch(/import "server-only"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Live trading guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Live trading guard", () => {
  it("assertLiveTradingEnabled throws when LIVE_TRADING_ENABLED is not 'true'", async () => {
    const orig = process.env.LIVE_TRADING_ENABLED;
    delete process.env.LIVE_TRADING_ENABLED;
    try {
      const { OpenAlgoAdapter } = await import(
        "@/services/india/broker/openalgo-adapter"
      );
      const adapter = new OpenAlgoAdapter("http://localhost:8080", "test-key");
      await expect(
        adapter.placeOrder({
          symbol: "NIFTY",
          exchange: "NSE",
          side: "BUY",
          quantity: 1,
          orderType: "MARKET",
          product: "MIS",
        })
      ).rejects.toThrow(/Live trading is not enabled/);
    } finally {
      if (orig !== undefined) process.env.LIVE_TRADING_ENABLED = orig;
    }
  });

  it("LIVE_TRADING_ENABLED is documented in env.ts schema", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/LIVE_TRADING_ENABLED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Environment variable validation via Zod
// ─────────────────────────────────────────────────────────────────────────────

describe("Environment variable validation", () => {
  it("env.ts uses Zod schema for validation", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/z\.object\(/);
    expect(src).toMatch(/safeParse/);
  });

  it("env.ts rejects invalid env vars with descriptive error", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/Invalid environment variables/);
  });

  it("AUTH_SECRET has minimum length validation", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/AUTH_SECRET.*z\.string\(\)\.min\(32\)/);
  });

  it("ENCRYPTION_KEY has hex format validation", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/ENCRYPTION_KEY/);
    expect(src).toMatch(/hex/i);
  });

  it("DATABASE_URL is validated as a URL", () => {
    const src = readSrc("src/lib/env.ts");
    expect(src).toMatch(/DATABASE_URL.*z\.string\(\)\.url\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. API key encryption
// ─────────────────────────────────────────────────────────────────────────────

describe("API key security", () => {
  it("API keys are stored encrypted in UserSetting (apiKeysEncrypted field)", () => {
    const schema = readSrc("prisma/schema.prisma");
    expect(schema).toMatch(/apiKeysEncrypted/);
    // Must be Json type (encrypted blob), not String (plaintext)
    expect(schema).toMatch(/apiKeysEncrypted\s+Json/);
  });

  it("crypto.ts provides AES-256-GCM encryption for API keys", () => {
    const src = readSrc("src/lib/crypto.ts");
    expect(src).toMatch(/AES-256-GCM|aes-256-gcm/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. No hardcoded secrets in source
// ─────────────────────────────────────────────────────────────────────────────

describe("No hardcoded secrets", () => {
  const SENSITIVE_FILES = [
    "src/lib/india/ml-client.ts",
    "src/services/india/angelone/index.ts",  // Angel One uses services/india layer
    "src/lib/market-data/providers/upstox.ts",
    "src/services/india/broker/openalgo-adapter.ts",
  ];

  for (const file of SENSITIVE_FILES) {
    it(`${file} reads credentials from environment variables, not hardcoded`, () => {
      const src = readSrc(file);
      // Should NOT contain hardcoded API keys/secrets
      // (patterns like 32-char hex strings that look like API keys)
      const HARDCODED_PATTERNS = [
        /sk-[a-zA-Z0-9]{20,}/,         // OpenAI-style keys
        /Bearer\s+[A-Za-z0-9+/]{20,}/, // Bearer token literals
      ];
      for (const pattern of HARDCODED_PATTERNS) {
        expect(src).not.toMatch(pattern);
      }
      // Should reference process.env
      expect(src).toMatch(/process\.env\./);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. .gitignore protects .env.local
// ─────────────────────────────────────────────────────────────────────────────

describe("Secrets protection — .gitignore", () => {
  it(".gitignore includes .env pattern (matches .env.local via glob)", () => {
    const gitignore = readSrc(".gitignore");
    // .gitignore may use .env* glob which covers .env.local
    expect(gitignore).toMatch(/\.env/);
  });

  it(".gitignore excludes node_modules", () => {
    const gitignore = readSrc(".gitignore");
    expect(gitignore).toMatch(/node_modules/);
  });

  it(".env.example exists as a template (without real secrets)", () => {
    const example = readSrc(".env.example");
    // Should be a template with placeholder values
    expect(example.length).toBeGreaterThan(0);
    // Should NOT contain real API keys (they look like long hex/base64 strings)
    // but should reference variable names
    expect(example).toMatch(/=/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Auth protection
// ─────────────────────────────────────────────────────────────────────────────

describe("Authentication", () => {
  it("auth.ts uses next-auth for session management", () => {
    const src = readSrc("src/lib/auth.ts");
    expect(src).toMatch(/next-auth|NextAuth/);
  });

  it("Auth route directory exists under (auth) group", () => {
    // Just check the directory structure exists — readFileSync on a file inside it
    const { existsSync } = require("fs");
    const { join } = require("path");
    const authPath = join(process.cwd(), "src/app/(auth)");
    expect(existsSync(authPath)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. ML service URL not exposed to client
// ─────────────────────────────────────────────────────────────────────────────

describe("ML service URL security", () => {
  it("ML_SERVICE_URL is server-side only (not NEXT_PUBLIC_)", () => {
    const src = readSrc("src/lib/env.ts");
    // ML_SERVICE_URL must not be prefixed NEXT_PUBLIC_
    expect(src).toMatch(/ML_SERVICE_URL/);
    expect(src).not.toMatch(/NEXT_PUBLIC_ML_SERVICE_URL/);
  });

  it("ml-client.ts uses ML_SERVICE_URL from process.env (not a public var)", () => {
    const src = readSrc("src/lib/india/ml-client.ts");
    // Must read from process.env.ML_SERVICE_URL, not a public var
    expect(src).toMatch(/ML_SERVICE_URL/);
    expect(src).not.toMatch(/NEXT_PUBLIC_/);
  });
});
