import { LogOut, User as UserIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { signOutAction } from "@/features/auth/signout";

interface ProfileHeaderProps {
  email: string;
  name: string | null;
  defaultPair: "BTC" | "ETH" | "SOL";
  hasApiKeys: boolean;
  /** Account creation timestamp serialised as ISO string. */
  createdAt: string;
}

function initialsFor(name: string | null, email: string): string {
  return (name?.trim() || email)
    .split(/[\s@]/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

function memberSinceLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/**
 * Identity card that anchors the profile page — avatar, display name,
 * email, a couple of at-a-glance status pills (default trading pair, API
 * key configured / not) and a sign-out button. Rendered as a server
 * component so the form submits straight to the `signOutAction` server
 * action without an intermediate client roundtrip.
 */
export function ProfileHeader({
  email,
  name,
  defaultPair,
  hasApiKeys,
  createdAt,
}: ProfileHeaderProps) {
  const initials = initialsFor(name, email);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4 min-w-0">
          <div
            aria-hidden
            className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-info)] text-base font-semibold uppercase text-[var(--color-brand-foreground)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
          >
            {initials || <UserIcon className="h-6 w-6" />}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight text-[var(--color-fg)]">
              {name?.trim() || email}
            </h2>
            <p className="truncate text-[12px] text-[var(--color-fg-muted)]">{email}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">Default pair · {defaultPair}</Badge>
              <Badge variant={hasApiKeys ? "bull" : "outline"}>
                {hasApiKeys ? "API keys configured" : "No API keys"}
              </Badge>
              <Badge variant="outline">Member since {memberSinceLabel(createdAt)}</Badge>
            </div>
          </div>
        </div>

        <form action={signOutAction} className="self-stretch sm:self-auto">
          <Button
            type="submit"
            variant="secondary"
            className="w-full sm:w-auto"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
