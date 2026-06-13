import { LogIn, Search } from "lucide-react";
import Link from "next/link";

import { ConnectionPill } from "@/components/dashboard/connection-pill";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";

interface TopbarUser {
  email: string;
  name?: string | null;
}

interface TopbarProps {
  user: TopbarUser | null;
}

/**
 * Two-button anonymous CTA shown in place of the notifications bell + user
 * avatar when nobody is signed in. The styling matches the
 * `<Button variant="secondary">` / `<Button variant="primary">` palette so
 * the topbar stays visually consistent across auth states without pulling
 * the Button component into a server-only context.
 */
function SignInCta() {
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg)] transition-colors hover:bg-[color-mix(in_oklch,var(--color-surface)_85%,var(--color-fg))]"
      >
        <LogIn className="h-3.5 w-3.5" />
        Sign in
      </Link>
      <Link
        href="/signup"
        className="hidden h-9 items-center gap-2 rounded-lg bg-[var(--color-brand)] px-3 text-xs font-semibold text-[var(--color-brand-foreground)] transition-colors hover:bg-[color-mix(in_oklch,var(--color-brand)_88%,white)] sm:inline-flex"
      >
        Create account
      </Link>
    </div>
  );
}

export function Topbar({ user }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 px-6 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-bg)]/60">
      <div className="flex items-center gap-3">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--color-fg-subtle)]" />
          <input
            type="search"
            placeholder="Search symbol, signal, alert…"
            className="h-9 w-[320px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] pl-9 pr-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-border-strong)] focus:outline-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <ConnectionPill />
        <ThemeToggle />
        {user ? (
          <>
            <NotificationsBell />
            <UserMenu email={user.email} name={user.name} />
          </>
        ) : (
          <SignInCta />
        )}
      </div>
    </header>
  );
}
