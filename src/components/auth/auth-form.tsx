"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/features/auth/actions";

type Action = (state: ActionResult | undefined, formData: FormData) => Promise<ActionResult>;

interface FieldDef {
  name: "name" | "email" | "password";
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  placeholder?: string;
}

interface AuthFormProps {
  mode: "login" | "signup";
  action: Action;
  submitLabel: string;
}

const LOGIN_FIELDS: FieldDef[] = [
  { name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@example.com" },
  { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
];

const SIGNUP_FIELDS: FieldDef[] = [
  { name: "name", label: "Name", type: "text", autoComplete: "name", placeholder: "Satoshi" },
  { name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@example.com" },
  {
    name: "password",
    label: "Password",
    type: "password",
    autoComplete: "new-password",
    placeholder: "8+ chars, with a letter and a number",
  },
];

export function AuthForm({ mode, action, submitLabel }: AuthFormProps) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(action, undefined);
  const fields = mode === "login" ? LOGIN_FIELDS : SIGNUP_FIELDS;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {fields.map((field) => {
        const fieldErr = state?.fieldErrors?.[field.name]?.[0];
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              name={field.name}
              type={field.type}
              autoComplete={field.autoComplete}
              placeholder={field.placeholder}
              required
              aria-invalid={fieldErr ? "true" : undefined}
              aria-describedby={fieldErr ? `${field.name}-error` : undefined}
            />
            {fieldErr ? (
              <p id={`${field.name}-error`} className="text-[11px] text-[var(--color-bear)]">
                {fieldErr}
              </p>
            ) : null}
          </div>
        );
      })}

      {state?.error ? (
        <p
          role="alert"
          className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
        >
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="mt-1">
        {pending ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
