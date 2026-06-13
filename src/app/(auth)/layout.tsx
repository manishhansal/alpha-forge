import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import Link from "next/link";

import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // If a signed-in user lands on /login or /signup, send them home.
  const session = await auth();
  if (session?.user) redirect("/");

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-[var(--color-bg)] px-6 py-12 text-[var(--color-fg)]">
      <Link href="/" className="mb-8 flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-info)] text-[var(--color-brand-foreground)]">
          <Activity className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-base font-semibold tracking-tight">Alphaforge</span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-fg-subtle)]">
            Multi-market trading desk
          </span>
        </div>
      </Link>
      <main className="w-full max-w-[400px]">{children}</main>
    </div>
  );
}
