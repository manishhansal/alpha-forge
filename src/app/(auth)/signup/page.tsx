import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { signupAction } from "@/features/auth/actions";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          Create your account
        </CardTitle>
        <CardDescription>Free, no email verification required.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <AuthForm mode="signup" action={signupAction} submitLabel="Create account" />
        <p className="text-[12px] text-[var(--color-fg-muted)]">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--color-info)] hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
