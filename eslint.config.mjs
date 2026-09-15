import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Data-Service2.0 Import Boundary — no-restricted-imports
 *
 * After the data-service2.0 centralization refactor, all market-data access
 * MUST flow through the canonical client:
 *   @/lib/data-service/client
 *
 * Direct imports of any market-data provider SDK or service are forbidden.
 * The old ProviderRegistry, provider adapters, and broker market-data modules
 * no longer exist. Any import of them is a build error.
 *
 * Allowed: @/services/india/angelone (portfolio/execution only — not market data)
 *          @/services/india/broker   (order execution only)
 */
const dataServiceBoundaryRule = [
  "error",
  {
    patterns: [
      // Deleted market-data provider modules — must not be re-imported
      {
        group: ["yahoo-finance2", "**/yahoo-finance2*"],
        message:
          "yahoo-finance2 was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/lib/market-data/registry*", "@/lib/market-data/registry*"],
        message:
          "ProviderRegistry was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/lib/market-data/providers/**", "@/lib/market-data/providers/**"],
        message:
          "Provider adapters were removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/lib/market-data/services/**", "@/lib/market-data/services/**"],
        message:
          "Market-data services were removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/india/yahoo*", "@/services/india/yahoo*"],
        message:
          "Yahoo adapter was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/india/nse*", "@/services/india/nse*"],
        message:
          "NSE direct access was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/india/groww*", "@/services/india/groww*"],
        message:
          "Groww adapter was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/binance*", "@/services/binance*"],
        message:
          "Binance direct access was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/deribit*", "@/services/deribit*"],
        message:
          "Deribit direct access was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
      {
        group: ["**/services/coingecko*", "@/services/coingecko*"],
        message:
          "CoinGecko direct access was removed. Use DataServiceClient from @/lib/data-service/client.",
      },
    ],
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Data-service2.0 boundary: enforce for all files.
  {
    rules: {
      "no-restricted-imports": dataServiceBoundaryRule,
      // Ignore intentionally-unused parameters/variables prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
