import { z } from "zod";

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().optional(),
  COINGLASS_API_KEY: z.string().optional(),
  DERIBIT_CLIENT_ID: z.string().optional(),
  DERIBIT_SECRET: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),

  // Auth.js v5
  // 32+ random bytes (e.g. `openssl rand -hex 32` or `npx auth secret`).
  // Optional at boot so the Next app can still build without it, but required
  // for any auth-touching code path at runtime.
  AUTH_SECRET: z.string().min(32).optional(),
  AUTH_TRUST_HOST: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  // API-key / sensitive-field encryption (AES-256-GCM). 64 hex chars = 32 bytes.
  // Optional at boot; required when the user actually saves an exchange API key.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/u, "ENCRYPTION_KEY must be 64 hex characters (32 bytes)")
    .optional(),

  // Alert delivery channels
  RESEND_API_KEY: z.string().optional(),
  // Accept either a bare email (`a@b.com`) or RFC 5322 display-name form
  // (`Name <a@b.com>`) — the latter is what Resend/SES expect and matches the
  // default in `src/features/alerts/channels.ts`.
  ALERT_EMAIL_FROM: z
    .string()
    .regex(
      /^(?:[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+|[^<>]+<\s*[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+\s*>)$/u,
      "ALERT_EMAIL_FROM must be an email or `Name <email@host>`",
    )
    .optional(),
  ALERT_WEBHOOK_SIGNING_SECRET: z.string().min(16).optional(),

  // Worker tuning (all optional; sensible defaults in worker/src/config.ts)
  WORKER_LIQUIDATION_SYMBOLS: z.string().optional(),
  WORKER_SIGNAL_INGEST_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  WORKER_SIGNAL_OUTCOME_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  WORKER_ALERTS_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  WORKER_APP_BASE_URL: z.string().url().optional(),
  WORKER_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  WORKER_LOG_FORMAT: z.enum(["pretty", "json"]).optional(),
  WORKER_SERVICE_NAME: z.string().optional(),

  // Observability — when SENTRY_DSN is unset every Sentry call is a no-op so
  // local dev never pays the SDK cost. Tracing is opt-in.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),

  // Server-side default broker. Falls back to `NEXT_PUBLIC_ACTIVE_BROKER` if
  // unset so the same env line can drive both layers. Default: delta.
  ACTIVE_BROKER: z.enum(["binance", "delta"]).optional(),

  // Delta Exchange India REST base. Override for testnet
  // (`https://cdn-ind.testnet.deltaex.org`).
  DELTA_REST_BASE_URL: z.string().url().default("https://api.india.delta.exchange"),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_BINANCE_WS: z.string().default("wss://stream.binance.com:9443/stream"),
  NEXT_PUBLIC_BINANCE_FUTURES_WS: z.string().default("wss://fstream.binance.com/stream"),
  NEXT_PUBLIC_BYBIT_WS: z.string().default("wss://stream.bybit.com/v5/public/linear"),
  // Delta Exchange India public WS endpoint. The new public endpoint hosts
  // `ticker`, `funding_rate`, `mark_price`, `candlesticks`, etc.
  NEXT_PUBLIC_DELTA_WS: z
    .string()
    .default("wss://public-socket.india.delta.exchange"),
  /**
   * Active broker visible to the client (browser hooks read this to decide
   * which WS endpoint to open). Default: delta.
   */
  NEXT_PUBLIC_ACTIVE_BROKER: z.enum(["binance", "delta"]).default("delta"),
});

type ServerEnv = z.infer<typeof serverSchema>;
type ClientEnv = z.infer<typeof clientSchema>;

const processEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  COINGLASS_API_KEY: process.env.COINGLASS_API_KEY,
  DERIBIT_CLIENT_ID: process.env.DERIBIT_CLIENT_ID,
  DERIBIT_SECRET: process.env.DERIBIT_SECRET,
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  ALERT_EMAIL_FROM: process.env.ALERT_EMAIL_FROM,
  ALERT_WEBHOOK_SIGNING_SECRET: process.env.ALERT_WEBHOOK_SIGNING_SECRET,
  WORKER_LIQUIDATION_SYMBOLS: process.env.WORKER_LIQUIDATION_SYMBOLS,
  WORKER_SIGNAL_INGEST_INTERVAL_MS: process.env.WORKER_SIGNAL_INGEST_INTERVAL_MS,
  WORKER_SIGNAL_OUTCOME_INTERVAL_MS: process.env.WORKER_SIGNAL_OUTCOME_INTERVAL_MS,
  WORKER_ALERTS_INTERVAL_MS: process.env.WORKER_ALERTS_INTERVAL_MS,
  WORKER_APP_BASE_URL: process.env.WORKER_APP_BASE_URL,
  WORKER_LOG_LEVEL: process.env.WORKER_LOG_LEVEL,
  WORKER_LOG_FORMAT: process.env.WORKER_LOG_FORMAT,
  WORKER_SERVICE_NAME: process.env.WORKER_SERVICE_NAME,
  SENTRY_DSN: process.env.SENTRY_DSN,
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  SENTRY_RELEASE: process.env.SENTRY_RELEASE,
  SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
  ACTIVE_BROKER: process.env.ACTIVE_BROKER,
  DELTA_REST_BASE_URL: process.env.DELTA_REST_BASE_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_BINANCE_WS: process.env.NEXT_PUBLIC_BINANCE_WS,
  NEXT_PUBLIC_BINANCE_FUTURES_WS: process.env.NEXT_PUBLIC_BINANCE_FUTURES_WS,
  NEXT_PUBLIC_BYBIT_WS: process.env.NEXT_PUBLIC_BYBIT_WS,
  NEXT_PUBLIC_DELTA_WS: process.env.NEXT_PUBLIC_DELTA_WS,
  NEXT_PUBLIC_ACTIVE_BROKER: process.env.NEXT_PUBLIC_ACTIVE_BROKER,
};

const isServer = !(typeof globalThis !== "undefined" && "window" in globalThis);
const schema = isServer ? serverSchema.merge(clientSchema) : clientSchema;

// Treat empty strings as missing so that `KEY=` in a `.env` file behaves like
// "not set" against `.optional()` schema fields. Without this, blank entries
// flow through as `""` and fail validators like `.email()`, `.url()`, `.min()`,
// or `.enum()` even though the developer's intent was clearly "leave unset".
const sanitizedEnv = Object.fromEntries(
  Object.entries(processEnv).map(([k, v]) => [k, v === "" ? undefined : v]),
);

const parsed = schema.safeParse(sanitizedEnv);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables. See server logs.");
}

export const env = parsed.data as ServerEnv & ClientEnv;
