/**
 * Optional Sentry integration for the worker process.
 *
 * Activation: set `SENTRY_DSN` in the environment. Without it, every export
 * here is a no-op so the worker has zero observability overhead in dev.
 *
 * Why a separate module:
 *   - The worker logger (`log.ts`) calls into here on every emit, so we keep
 *     the surface dead-simple and crash-proof. Any failure on the Sentry side
 *     is swallowed; observability must never take down the data pipeline.
 *   - Importing `@sentry/node` lazily lets the Next app and the worker share
 *     the same `node_modules` tree without paying the init cost when DSN is
 *     missing.
 */

import * as Sentry from "@sentry/node";

let initialized = false;
let enabled = false;

interface InitOptions {
  serviceName: string;
}

/**
 * Initialise the Sentry SDK once at worker bootstrap. Safe to call multiple
 * times — subsequent calls are no-ops. Reads config from the environment so
 * the worker doesn't need to thread an env object through.
 */
export function initObservability({ serviceName }: InitOptions): {
  enabled: boolean;
  dsnConfigured: boolean;
} {
  if (initialized) return { enabled, dsnConfigured: Boolean(process.env.SENTRY_DSN) };
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    return { enabled, dsnConfigured: false };
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      release: process.env.SENTRY_RELEASE,
      // Errors-only by default — tracing has a non-trivial CPU cost and the
      // worker isn't user-facing. Opt in via SENTRY_TRACES_SAMPLE_RATE.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
      // Stack-frame stitching for the unified worker process.
      serverName: serviceName,
      initialScope: {
        tags: {
          component: "worker",
          service: serviceName,
        },
      },
    });
    enabled = true;
  } catch (err) {
    enabled = false;
    // Best-effort log via stderr; the logger isn't available yet during boot.
    console.error("[observability] Sentry init failed:", (err as Error).message);
  }
  return { enabled, dsnConfigured: true };
}

export function observabilityEnabled(): boolean {
  return enabled;
}

interface LogLikeRecord {
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  msg: string;
  meta?: unknown;
}

/**
 * Push a non-error log line as a Sentry breadcrumb. Cheap when Sentry is off.
 */
export function captureLogBreadcrumb(record: LogLikeRecord): void {
  if (!enabled) return;
  try {
    Sentry.addBreadcrumb({
      category: record.scope,
      level: record.level === "warn" ? "warning" : record.level,
      message: record.msg,
      data:
        record.meta !== undefined && typeof record.meta === "object" && record.meta !== null
          ? (record.meta as Record<string, unknown>)
          : record.meta !== undefined
            ? { value: record.meta }
            : undefined,
    });
  } catch {
    // observability must never throw
  }
}

/**
 * Send a structured `error`-level log line up as a Sentry event. If `meta`
 * contains an Error-shaped `err` we forward the stack; otherwise we capture
 * the message with the scope as a tag.
 */
export function captureLogError(record: LogLikeRecord): void {
  if (!enabled) return;
  try {
    const meta = (record.meta as { err?: string; stack?: string } | undefined) ?? undefined;
    if (meta?.err) {
      const err = new Error(meta.err);
      if (meta.stack) err.stack = meta.stack;
      Sentry.withScope((scope) => {
        scope.setTag("scope", record.scope);
        scope.setExtra("msg", record.msg);
        if (meta) scope.setExtras(meta as unknown as Record<string, unknown>);
        Sentry.captureException(err);
      });
      return;
    }
    Sentry.withScope((scope) => {
      scope.setTag("scope", record.scope);
      if (record.meta !== undefined) scope.setExtra("meta", record.meta);
      Sentry.captureMessage(record.msg, "error");
    });
  } catch {
    // observability must never throw
  }
}

/**
 * Capture an `Error` directly (e.g. from `process.on('uncaughtException')`).
 */
export function captureError(err: Error, context?: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    Sentry.withScope((scope) => {
      if (context) scope.setExtras(context);
      Sentry.captureException(err);
    });
  } catch {
    // observability must never throw
  }
}

/**
 * Flush queued events on shutdown so SIGTERM doesn't drop the last error.
 * Returns true on success / when disabled, false on flush failure.
 */
export async function flushObservability(timeoutMs = 2000): Promise<boolean> {
  if (!enabled) return true;
  try {
    return await Sentry.close(timeoutMs);
  } catch {
    return false;
  }
}
