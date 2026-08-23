"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface PanelHeaderProps {
  title: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ title, icon, badge, action, className }: PanelHeaderProps) {
  return (
    <div
      className={cn("flex items-center justify-between px-4", className)}
      style={{ height: "40px", minHeight: "40px" }}
    >
      <div className="flex items-center gap-2">
        {icon && <span className="flex-shrink-0 text-[var(--color-fg-muted)]">{icon}</span>}
        <h3
          className="text-sm font-semibold leading-none"
          style={{ color: "var(--color-fg)" }}
        >
          {title}
        </h3>
        {badge && <span className="ml-1">{badge}</span>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}
