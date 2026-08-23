"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  error: Error | string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-12 text-center", className)}>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl"
        style={{
          backgroundColor: "color-mix(in oklch, var(--data-negative) 10%, transparent)",
          color: "var(--color-data-negative)",
        }}
        aria-hidden="true"
      >
        <AlertCircle className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold" style={{ color: "var(--color-fg)" }}>
          Something went wrong
        </h3>
        <p className="text-xs max-w-xs" style={{ color: "var(--color-fg-muted)" }}>
          {message}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-lg px-4 py-2 text-xs font-medium transition-colors"
          style={{
            backgroundColor: "color-mix(in oklch, var(--data-negative) 8%, transparent)",
            color: "var(--color-data-negative)",
            border: "1px solid color-mix(in oklch, var(--data-negative) 25%, transparent)",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
