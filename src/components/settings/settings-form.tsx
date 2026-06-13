"use client";

import { useActionState, useEffect } from "react";

import { useTheme, type Theme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type SettingsActionResult,
  updateSettingsAction,
} from "@/features/settings/actions";

interface SettingsFormProps {
  initial: {
    email: string;
    name: string | null;
    defaultPair: "BTC" | "ETH" | "SOL";
    theme: string;
  };
}

const PAIRS = ["BTC", "ETH", "SOL"] as const;
const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System (follow OS)" },
];

function normalizeTheme(t: string): Theme {
  return t === "light" || t === "dark" || t === "system" ? t : "system";
}

export function SettingsForm({ initial }: SettingsFormProps) {
  const [state, action, pending] = useActionState<SettingsActionResult | undefined, FormData>(
    updateSettingsAction,
    undefined,
  );
  const { theme, setTheme } = useTheme();

  // On first mount, prefer the saved server-side preference over whatever
  // localStorage has — keeps multi-device users in sync. After that, every
  // <select> change updates the provider live (so the preview is instant)
  // and is persisted to the DB on form submit via the server action.
  useEffect(() => {
    const serverTheme = normalizeTheme(initial.theme);
    if (serverTheme !== theme) setTheme(serverTheme);
    // We only want this to run once on first mount with the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" defaultValue={initial.email} readOnly disabled />
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          Email is used as your sign-in identifier. Contact support to change it.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Display name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          defaultValue={initial.name ?? ""}
          maxLength={80}
          placeholder="Optional"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="defaultPair">Default trading pair</Label>
        <select
          id="defaultPair"
          name="defaultPair"
          defaultValue={initial.defaultPair}
          className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] focus:border-[var(--color-border-strong)] focus:outline-none"
        >
          {PAIRS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="theme">Theme</Label>
        <select
          id="theme"
          name="theme"
          value={theme}
          onChange={(e) => setTheme(normalizeTheme(e.target.value))}
          className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] focus:border-[var(--color-border-strong)] focus:outline-none"
        >
          {THEMES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          Preview is live. Click <span className="font-medium">Save changes</span> to persist your preference across devices.
        </p>
      </div>

      {state?.error ? (
        <p
          role="alert"
          className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
        >
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="rounded-md border border-[color-mix(in_oklch,var(--color-bull)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bull)]">
          Saved.
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
