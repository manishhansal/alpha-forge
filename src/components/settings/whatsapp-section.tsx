"use client";

import { ExternalLink, Loader2, MessageCircle, Trash2 } from "lucide-react";
import { startTransition, useActionState, useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type SavePhoneActionResult,
  deletePhoneAction,
  savePhoneAction,
  saveWhatsAppPrefsAction,
} from "@/features/whatsapp/whatsapp-actions";
import {
  WHATSAPP_EVENT_TYPES,
  type WhatsAppEventType,
  type WhatsAppPreferences,
} from "@/features/whatsapp/shared";

// ─── Client-side phone validation ─────────────────────────────────────────────
// Mirrors `E164_REGEX` from `features/whatsapp/phone.ts` (server-only).
// We duplicate the pure regex here to avoid pulling in the server-only module.
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function validatePhone(phone: string): { ok: boolean; error?: string } {
  if (!phone) return { ok: false, error: "Phone number is required." };
  if (!E164_REGEX.test(phone)) {
    return {
      ok: false,
      error: 'Phone number must be in E.164 format (e.g. +919876543210) — a "+" followed by 7–15 digits.',
    };
  }
  return { ok: true };
}

// ─── Label map for event type toggles ────────────────────────────────────────

const EVENT_LABELS: Record<WhatsAppEventType, string> = {
  DAILY_PICKS_NEW: "Daily Picks",
  AI_SIGNAL_NEW: "AI Signals",
  SCANNER_HIT_NEW: "Scanner Signals",
  SIGNALS_BOARD_NEW: "Signals Board",
  PAPER_TRADE_OPENED: "Paper Trading",
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface WhatsAppSectionProps {
  /**
   * Whether `WHATSAPP_EVOLUTION_API_URL` is set on the server.
   * When false, a configuration banner is shown.
   *
   * Requirement 11.3
   */
  evolutionConfigured: boolean;

  /**
   * Masked phone number (`"+91 98765 •••••"`) when a phone is already stored,
   * or null when no phone is saved yet.
   *
   * Requirement 2.5
   */
  maskedPhone: string | null;

  /**
   * Initial WhatsApp notification preferences loaded server-side.
   *
   * Requirements 3.1, 3.4
   */
  initialPrefs: WhatsAppPreferences;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * WhatsAppSection — rendered inside the Profile / API Keys settings card.
 *
 * Covers:
 *  - Configuration banner when Evolution API URL is unset (Requirement 11.3)
 *  - Phone number form with E.164 validation, save & remove actions (Requirement 2.1, 2.5, 2.6, 2.7)
 *  - WhatsApp Alerts toggles for five event types (Requirement 3.1)
 *  - Send Test Message button with toast feedback (Requirement 11.5)
 *
 * Requirements: 2.1, 2.5, 2.6, 2.7, 3.1, 11.1, 11.2, 11.3, 11.5
 */
export function WhatsAppSection({
  evolutionConfigured,
  maskedPhone,
  initialPrefs,
}: WhatsAppSectionProps) {
  // ── Phone form state ──────────────────────────────────────────────────────

  const [phoneInput, setPhoneInput] = useState("");
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const [hasPhone, setHasPhone] = useState(Boolean(maskedPhone));
  const [displayMasked, setDisplayMasked] = useState<string | null>(maskedPhone);

  const [saveState, saveAction, savePending] = useActionState<
    SavePhoneActionResult | undefined,
    FormData
  >(savePhoneAction, undefined);

  const [delState, delAction, delPending] = useActionState<
    SavePhoneActionResult | undefined,
    FormData
  >(deletePhoneAction, undefined);

  // Update local phone display state when server action succeeds
  useEffect(() => {
    if (saveState?.ok) {
      // Phone was saved — show masked in next render cycle.
      // The masked value will come via revalidation, but we optimistically clear the input.
      startTransition(() => {
        setPhoneInput("");
        setPhoneError(undefined);
        setHasPhone(true);
        // We don't have the new masked value here; the parent will rerender with it.
      });
    }
  }, [saveState?.ok]);

  useEffect(() => {
    if (delState?.ok) {
      startTransition(() => {
        setHasPhone(false);
        setDisplayMasked(null);
        setPhoneInput("");
      });
    }
  }, [delState?.ok]);

  // Client-side inline validation on input change (Requirement 2.7)
  const handlePhoneChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPhoneInput(val);
    if (val.length > 0) {
      const result = validatePhone(val);
      setPhoneError(result.ok ? undefined : result.error);
    } else {
      setPhoneError(undefined);
    }
  }, []);

  // Prevent submission when invalid (Requirement 2.7)
  const handlePhoneSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      const result = validatePhone(phoneInput);
      if (!result.ok) {
        e.preventDefault();
        setPhoneError(result.error);
      }
    },
    [phoneInput],
  );

  // ── WhatsApp Alerts toggles ───────────────────────────────────────────────

  const [enabledEvents, setEnabledEvents] = useState<Set<WhatsAppEventType>>(
    new Set(initialPrefs.enabledEvents),
  );
  const [prefsSaving, startPrefsSave] = useTransition();

  const handleToggle = useCallback(
    (eventType: WhatsAppEventType) => {
      const next = new Set(enabledEvents);
      if (next.has(eventType)) {
        next.delete(eventType);
      } else {
        next.add(eventType);
      }
      setEnabledEvents(next);

      startPrefsSave(async () => {
        const result = await saveWhatsAppPrefsAction({
          enabledEvents: Array.from(next),
        });
        if (!result.ok) {
          toast.error("Failed to save notification preferences", {
            description: result.error,
          });
        }
      });
    },
    [enabledEvents],
  );

  // ── Send Test Message ─────────────────────────────────────────────────────

  const [testPending, setTestPending] = useState(false);

  const handleSendTest = useCallback(async () => {
    setTestPending(true);
    try {
      const res = await fetch("/api/in/whatsapp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
      };
      if (res.ok && json.ok) {
        toast.success("Test message delivered", {
          description: json.message ?? "Check your WhatsApp.",
          duration: 5000,
        });
      } else {
        toast.error("Test message failed", {
          description: json.message ?? `HTTP ${res.status}`,
          duration: 6000,
        });
      }
    } catch (err) {
      toast.error("Test message failed", {
        description: (err as Error).message,
        duration: 6000,
      });
    } finally {
      setTestPending(false);
    }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center gap-2">
        <MessageCircle className="h-4 w-4 text-[var(--color-fg-muted)]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          WhatsApp Notifications
        </p>
      </div>

      {/* Configuration banner — shown when Evolution API URL is not configured */}
      {!evolutionConfigured ? (
        <div className="rounded-md border border-[color-mix(in_oklch,var(--color-info)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-info)_8%,transparent)] px-3 py-2.5 text-[12px] text-[var(--color-info)]">
          Self-hosted Evolution-Go instance required.{" "}
          <a
            href="https://github.com/evolution-foundation/evolution-go"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 hover:no-underline"
          >
            Set up Evolution-Go
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}

      {/* Phone number form */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
        <p className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          Phone number
        </p>

        {/* Masked preview when phone is stored */}
        {hasPhone && displayMasked ? (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[var(--color-fg-muted)]">Saved number:</span>
              <span className="num font-mono text-sm text-[var(--color-fg)]">{displayMasked}</span>
            </div>
          </div>
        ) : null}

        {/* Save phone form */}
        {!hasPhone ? (
          <form
            action={saveAction}
            onSubmit={handlePhoneSubmit}
            className="flex flex-col gap-3"
            noValidate
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="whatsapp-phone">WhatsApp number (E.164)</Label>
              <div className="flex gap-2">
                <Input
                  id="whatsapp-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+919876543210"
                  value={phoneInput}
                  onChange={handlePhoneChange}
                  disabled={savePending}
                  aria-describedby={phoneError ? "whatsapp-phone-error" : undefined}
                  aria-invalid={Boolean(phoneError)}
                  className="flex-1"
                />
                <Button type="submit" disabled={savePending || Boolean(phoneError)}>
                  {savePending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {savePending ? "Saving…" : "Save"}
                </Button>
              </div>
              {phoneError ? (
                <p
                  id="whatsapp-phone-error"
                  role="alert"
                  className="text-[11px] text-[var(--color-bear)]"
                >
                  {phoneError}
                </p>
              ) : null}
              {saveState?.error ? (
                <p
                  role="alert"
                  className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
                >
                  {saveState.error}
                </p>
              ) : null}
              <p className="text-[11px] text-[var(--color-fg-subtle)]">
                Include the country code, e.g. <span className="num font-mono">+919876543210</span>{" "}
                for India. Stored encrypted with AES-256-GCM.
              </p>
            </div>
          </form>
        ) : null}

        {/* Remove phone form */}
        {hasPhone ? (
          <form action={delAction} className="flex flex-col gap-2">
            {delState?.error ? (
              <p
                role="alert"
                className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-bear)]"
              >
                {delState.error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={delPending}
                aria-label="Remove saved WhatsApp phone number"
              >
                {delPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {delPending ? "Removing…" : "Remove number"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>

      {/* WhatsApp Alerts toggles */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
        <p className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
          WhatsApp Alerts
        </p>
        <div className="flex flex-col gap-2">
          {WHATSAPP_EVENT_TYPES.map((eventType) => {
            const isEnabled = enabledEvents.has(eventType);
            return (
              <label
                key={eventType}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <span className="text-sm text-[var(--color-fg)]">
                  {EVENT_LABELS[eventType]}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  aria-label={`Toggle ${EVENT_LABELS[eventType]} WhatsApp alerts`}
                  disabled={prefsSaving}
                  onClick={() => handleToggle(eventType)}
                  className={[
                    "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                    isEnabled
                      ? "bg-[var(--color-brand)]"
                      : "bg-[var(--color-border)]",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform",
                      isEnabled ? "translate-x-4" : "translate-x-0",
                    ].join(" ")}
                  />
                </button>
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">
          Preferences are saved automatically. Only events where a phone number is configured will
          be dispatched.
        </p>
      </div>

      {/* Send Test Message */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">
            Send Test Message
          </span>
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            Sends a sample WhatsApp message to verify your configuration.
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={testPending || !hasPhone || !evolutionConfigured}
          onClick={() => void handleSendTest()}
        >
          {testPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {testPending ? "Sending…" : "Send test"}
        </Button>
      </div>
    </div>
  );
}
