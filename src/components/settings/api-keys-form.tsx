"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type ApiKeysActionResult,
  deleteApiKeyAction,
  saveApiKeyAction,
} from "@/features/settings/api-keys-actions";
import {
  EXCHANGE_LABELS,
  SUPPORTED_EXCHANGES,
  type Exchange,
  type StoredKeySummary,
} from "@/features/settings/api-keys-shared";

interface ApiKeysFormProps {
  encryptionAvailable: boolean;
  stored: StoredKeySummary[];
}

export function ApiKeysForm({ encryptionAvailable, stored }: ApiKeysFormProps) {
  const [exchange, setExchange] = useState<Exchange>(SUPPORTED_EXCHANGES[0]);
  const [showSecret, setShowSecret] = useState(false);

  const [saveState, saveAction, savePending] = useActionState<
    ApiKeysActionResult | undefined,
    FormData
  >(saveApiKeyAction, undefined);
  const [delState, delAction, delPending] = useActionState<
    ApiKeysActionResult | undefined,
    FormData
  >(deleteApiKeyAction, undefined);

  const saveFieldError = (name: string) => saveState?.fieldErrors?.[name]?.[0];

  return (
    <div className="flex flex-col gap-5">
      {!encryptionAvailable ? (
        <p className="rounded-md border border-[color-mix(in_oklch,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-warning)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-warning)]">
          <code className="font-mono">ENCRYPTION_KEY</code> is not set on the server. Generate one
          with <code className="font-mono">openssl rand -hex 32</code> and add it to{" "}
          <code className="font-mono">.env.local</code> before saving any API keys.
        </p>
      ) : null}

      <form
        action={saveAction}
        className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4"
        noValidate
      >
        <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          Add or replace a key
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-exchange">Exchange</Label>
            <select
              id="api-exchange"
              name="exchange"
              value={exchange}
              onChange={(e) => setExchange(e.target.value as Exchange)}
              className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] focus:border-[var(--color-border-strong)] focus:outline-none"
            >
              {SUPPORTED_EXCHANGES.map((ex) => (
                <option key={ex} value={ex}>
                  {EXCHANGE_LABELS[ex]}
                </option>
              ))}
            </select>
            <FieldError msg={saveFieldError("exchange")} />
          </div>

          <div className="flex items-end pb-1 sm:col-start-2">
            <label
              htmlFor="api-readonly"
              className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]"
            >
              <input
                id="api-readonly"
                name="readOnly"
                type="checkbox"
                defaultChecked
                className="h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] accent-[var(--color-brand)]"
              />
              Read-only key (recommended)
            </label>
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="api-key">API key</Label>
            <Input
              id="api-key"
              name="apiKey"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the public API key here"
              disabled={!encryptionAvailable || savePending}
              required
            />
            <FieldError msg={saveFieldError("apiKey")} />
          </div>

          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="api-secret">API secret</Label>
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                {showSecret ? "Hide" : "Show"}
              </button>
            </div>
            <Input
              id="api-secret"
              name="apiSecret"
              type={showSecret ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the API secret here"
              disabled={!encryptionAvailable || savePending}
              required
            />
            <FieldError msg={saveFieldError("apiSecret")} />
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              Encrypted with AES-256-GCM before being stored. The plaintext never touches the
              database and is never logged.
            </p>
          </div>
        </div>

        {saveState?.error ? (
          <p
            role="alert"
            className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
          >
            {saveState.error}
          </p>
        ) : null}
        {saveState?.ok ? (
          <p className="rounded-md border border-[color-mix(in_oklch,var(--color-bull)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bull)]">
            Saved. Existing key for {EXCHANGE_LABELS[exchange]} was replaced.
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={!encryptionAvailable || savePending}>
            {savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {savePending ? "Saving…" : "Save key"}
          </Button>
        </div>
      </form>

      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          Configured keys
        </p>
        {stored.length === 0 ? (
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            No exchange keys saved yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {stored.map((s) => (
              <li
                key={s.exchange}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px]"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-semibold">{EXCHANGE_LABELS[s.exchange]}</span>
                  <span className="num text-[var(--color-fg-muted)]">
                    {s.keyPreview ? `••••${s.keyPreview}` : "—"}
                  </span>
                  {s.readOnly ? (
                    <Badge variant="info">Read-only</Badge>
                  ) : (
                    <Badge variant="warning">Trading</Badge>
                  )}
                  <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                    Updated {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </div>
                <form action={delAction}>
                  <input type="hidden" name="exchange" value={s.exchange} />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    disabled={delPending}
                    aria-label={`Delete ${EXCHANGE_LABELS[s.exchange]} key`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {delState?.error ? (
          <p
            role="alert"
            className="mt-2 rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
          >
            {delState.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FieldError({ msg }: { msg: string | undefined }) {
  if (!msg) return null;
  return (
    <p role="alert" className="text-[11px] text-[var(--color-bear)]">
      {msg}
    </p>
  );
}
