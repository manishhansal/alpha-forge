import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loginAction } from "@/features/auth/actions";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Welcome back
        </CardTitle>
        <CardDescription>Sign in to your dashboard.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <AuthForm mode="login" action={loginAction} submitLabel="Sign in" />
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          New here?{" "}
          <Link href="/signup" className="text-[var(--color-info)] hover:underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
