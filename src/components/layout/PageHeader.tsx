"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { RegimeBadge, type RegimeLabel } from "@/components/trading/RegimeBadge";

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  regime?: RegimeLabel;
  action?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, regime, action, className }: PageHeaderProps) {
  return (
    <div className={cn("mb-6 flex items-start justify-between", className)}>
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold leading-tight" style={{ color: "var(--color-fg)" }}>
            {title}
          </h1>
          {regime && regime !== "UNKNOWN" && (
            <RegimeBadge regime={regime} animate />
          )}
        </div>
        {subtitle && (
          <p className="text-sm" style={{ color: "var(--color-fg-muted)" }}>
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}
