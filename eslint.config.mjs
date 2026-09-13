import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Canonical Import Boundary — no-restricted-imports
 *
 * All market-data access MUST flow through the ProviderRegistry (registry.ts).
 * Direct imports of broker/provider SDKs outside the Approved_Provider_Allowlist
 * are forbidden at CI time.
 *
 * Allowlist (files that MAY import these modules directly):
 *   src/lib/market-data/providers/angel-one.ts
 *   src/lib/market-data/providers/upstox.ts
 *   src/lib/market-data/providers/yahoo.ts
 *   src/lib/market-data/providers/scrapling.ts
 *   src/services/india/angelone/**  (adapter implementation)
 *   src/services/india/upstox/**    (adapter implementation)
 *   src/services/india/yahoo/**     (adapter implementation)
 *
 * Documented exceptions (broker-analytics endpoints with no MarketDataProvider
 * equivalent) must disable this rule inline with a comment referencing
 * DATA_SERVICE_PRE_REFACTOR_AUDIT.md. See canonical-import-guard.ts.
 */
const canonicalImportBoundaryRule = [
  "error",
  {
    patterns: [
      {
        group: ["**/services/india/yahoo*", "@/services/india/yahoo*"],
        message:
          "Use registry.getQuotes() or registry.getHistoricalCandles() instead. See canonical-import-guard.ts.",
      },
      {
        group: [
          "**/services/india/angelone*",
          "@/services/india/angelone*",
        ],
        message:
          "Use registry.getQuotes() etc. See canonical-import-guard.ts for documented exceptions.",
      },
      {
        group: ["yahoo-finance2"],
        message:
          "Use registry.getHistoricalCandles(). Direct Yahoo Finance access is prohibited outside the allowlist.",
      },
    ],
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Canonical import boundary: enforce for all files by default.
  {
    rules: {
      "no-restricted-imports": canonicalImportBoundaryRule,
    },
  },
  // Allowlist: provider adapter files may import broker SDKs directly.
  // The no-restricted-imports rule is disabled for these files only.
  {
    files: [
      "src/lib/market-data/providers/angel-one.ts",
      "src/lib/market-data/providers/upstox.ts",
      "src/lib/market-data/providers/yahoo.ts",
      "src/lib/market-data/providers/scrapling.ts",
      "src/services/india/angelone/**/*.ts",
      "src/services/india/angelone/**/*.tsx",
      "src/services/india/upstox/**/*.ts",
      "src/services/india/upstox/**/*.tsx",
      "src/services/india/yahoo/**/*.ts",
      "src/services/india/yahoo/**/*.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
