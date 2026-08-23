import { LogIn, Zap } from "lucide-react";
import Link from "next/link";

import { ConnectionPill } from "@/components/dashboard/connection-pill";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu } from "@/components/dashboard/user-menu";
import { TopbarSearch } from "@/components/dashboard/topbar-search";

interface TopbarUser {
  email: string;
  name?: string | null;
}

interface TopbarProps {
  user: TopbarUser | null;
}

function SignInCta() {
  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12px] font-medium text-[var(--color-fg)] transition-all hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]"
      >
        <LogIn className="h-3.5 w-3.5" />
        Sign in
      </Link>
      <Link
        href="/signup"
        className="hidden h-8 items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 text-[12px] font-semibold text-[var(--color-brand-foreground)] shadow-[0_0_16px_var(--glow-brand)] transition-all hover:shadow-[0_0_24px_var(--glow-brand)] hover:brightness-110 sm:inline-flex"
      >
        <Zap className="h-3 w-3" />
        Get started
      </Link>
    </div>
  );
}

export function Topbar({ user }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-13 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)]/80 px-5 backdrop-blur-xl">
      {/* Left: command palette trigger */}
      <div className="flex items-center gap-3">
        <TopbarSearch />
      </div>

      {/* Right: status + controls */}
      <div className="flex items-center gap-2">
        <ConnectionPill />
        <span className="h-4 w-px bg-[var(--color-border)]" aria-hidden />
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
