"use client";

import { User as UserIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { marketFromPath } from "@/lib/market-mode";
import { cn } from "@/lib/utils";

interface UserMenuProps {
  email: string;
  name: string | null | undefined;
}

/**
 * The user pill in the top-right of the dashboard. Clicking the avatar
 * (or the inline name/email block) navigates to the consolidated
 * /profile page — where account preferences, data sources, API keys,
 * alerts and sign-out all live. The link is market-aware so users on
 * /in/* stay on the India surface (`/in/profile`) and crypto users land
 * on `/profile`.
 */
export function UserMenu({ email, name }: UserMenuProps) {
  const pathname = usePathname();
  const market = marketFromPath(pathname);
  const href = market === "india" ? "/in/profile" : "/profile";

  const initials = (name?.trim() || email)
    .split(/[\s@]/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  const displayName = name?.trim() || email;
  const secondaryLine = name?.trim() ? email : "View profile";

  return (
    <Link
      href={href}
      aria-label="Open profile"
      title="Profile & settings"
      className={cn(
        "group flex items-center gap-2 rounded-lg p-0.5 pr-1 transition-colors",
        "hover:bg-[var(--color-surface)] focus-visible:bg-[var(--color-surface)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-strong)]",
      )}
    >
      <div className="hidden flex-col items-end leading-tight pl-2 sm:flex">
        <span className="text-[12px] font-medium text-[var(--color-fg)]">
          {displayName}
        </span>
        <span className="text-[10px] text-[var(--color-fg-subtle)]">
          {secondaryLine}
        </span>
      </div>
      <span
        aria-hidden
        className={cn(
          "grid h-8 w-8 place-items-center rounded-full bg-[var(--color-surface)] text-[11px] font-semibold uppercase text-[var(--color-fg-muted)] ring-1 ring-[var(--color-border)]",
          "transition-colors group-hover:text-[var(--color-fg)] group-hover:ring-[var(--color-border-strong)]",
        )}
      >
        {initials || <UserIcon className="h-4 w-4" />}
      </span>
    </Link>
  );
}
