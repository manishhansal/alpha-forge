"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: React.ComponentType<{ className?: string }>;
  heading: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon: Icon, heading, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-12 text-center", className)}>
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl"
        style={{ backgroundColor: "var(--color-surface)", color: "var(--color-fg-muted)" }}
        aria-hidden="true"
      >
        <Icon className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold" style={{ color: "var(--color-fg)" }}>
          {heading}
        </h3>
        {description && (
          <p className="text-xs max-w-xs" style={{ color: "var(--color-fg-muted)" }}>
            {description}
          </p>
        )}
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-1 rounded-lg px-4 py-2 text-xs font-medium transition-colors"
          style={{
            backgroundColor: "var(--color-surface)",
            color: "var(--color-fg)",
            border: "1px solid var(--color-panel-border)",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
