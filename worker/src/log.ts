import { captureLogBreadcrumb, captureLogError } from "./observability";

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Treat empty strings the same as unset. .env.example ships WORKER_LOG_LEVEL=
// (and friends) as the documented "use the default" form, and Node's
// --env-file parses that as "" rather than undefined. Without this guard,
// LEVEL_WEIGHT[""] is undefined and every shouldLog comparison silently
// returns false, swallowing every log line the worker tries to emit.
const rawLogLevel = process.env.WORKER_LOG_LEVEL?.trim();
const minLevel: Level =
  (rawLogLevel ? (rawLogLevel as Level) : undefined) ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

/**
 * Output format selector.
 *
 * - `pretty` (default in dev): human-readable single-line, what you want
 *   when tailing `npm run worker:dev`.
 * - `json` (default in production / containers): one JSON object per line,
 *   ready for shipping to Datadog / Loki / CloudWatch / Vector etc. without
 *   any extra log-shipper pre-processing.
 */
type LogFormat = "pretty" | "json";
const rawLogFormat = process.env.WORKER_LOG_FORMAT?.trim();
const logFormat: LogFormat =
  (rawLogFormat ? (rawLogFormat as LogFormat) : undefined) ??
  (process.env.NODE_ENV === "production" ? "json" : "pretty");

const SERVICE_NAME = process.env.WORKER_SERVICE_NAME?.trim() || "crypto-desk-worker";
const SERVICE_ENV = process.env.NODE_ENV ?? "development";

function shouldLog(level: Level): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[minLevel];
}

interface LogRecord {
  ts: string;
  level: Level;
  service: string;
  env: string;
  scope: string;
  msg: string;
  meta?: unknown;
}

function buildRecord(scope: string, level: Level, msg: string, meta?: unknown): LogRecord {
  return {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    env: SERVICE_ENV,
    scope,
    msg,
    ...(meta !== undefined ? { meta } : {}),
  };
}

function safeStringify(record: LogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    // Replace circular / non-serializable meta with a marker; we never want
    // a logging path to throw and crash the parent job.
    return JSON.stringify({ ...record, meta: "[unserializable meta]" });
  }
}

function fmtPretty(record: LogRecord): string {
  const base = `${record.ts} ${record.level.toUpperCase().padEnd(5)} [${record.scope}] ${record.msg}`;
  if (record.meta === undefined) return base;
  try {
    const tail = typeof record.meta === "string" ? record.meta : JSON.stringify(record.meta);
    return `${base} ${tail}`;
  } catch {
    return `${base} [unserializable meta]`;
  }
}

function emit(record: LogRecord): void {
  const line = logFormat === "json" ? safeStringify(record) : fmtPretty(record);
  switch (record.level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }

  // Push every log up to the optional observability sink (Sentry). Errors
  // become events; lower-severity records become breadcrumbs so an eventual
  // error has useful context attached.
  if (record.level === "error") {
    captureLogError(record);
  } else {
    captureLogBreadcrumb(record);
  }
}

export interface Logger {
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
  child: (subScope: string) => Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => {
      if (shouldLog("debug")) emit(buildRecord(scope, "debug", m, meta));
    },
    info: (m, meta) => {
      if (shouldLog("info")) emit(buildRecord(scope, "info", m, meta));
    },
    warn: (m, meta) => {
      if (shouldLog("warn")) emit(buildRecord(scope, "warn", m, meta));
    },
    error: (m, meta) => {
      if (shouldLog("error")) emit(buildRecord(scope, "error", m, meta));
    },
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
