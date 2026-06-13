import "server-only";

import { createHmac } from "node:crypto";

import { env } from "@/lib/env";

export interface ChannelDispatchInput {
  alertId: string;
  notificationId: string;
  userEmail: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  webhookUrl?: string | null;
}

export interface DispatchOutcome {
  channel: "IN_APP" | "EMAIL" | "WEBHOOK";
  ok: boolean;
  error?: string;
  status?: number;
}

/**
 * Webhook payload schema is fixed and documented for downstream consumers
 * (e.g. Zapier, n8n, custom integrations). The HMAC-SHA256 signature lives
 * in `X-Crypto-Desk-Signature` so receivers can verify authenticity.
 */
export interface WebhookPayload {
  alertId: string;
  notificationId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  ts: string;
}

export async function dispatchWebhook(input: ChannelDispatchInput): Promise<DispatchOutcome> {
  if (!input.webhookUrl) {
    return { channel: "WEBHOOK", ok: false, error: "no webhookUrl on alert" };
  }
  const payload: WebhookPayload = {
    alertId: input.alertId,
    notificationId: input.notificationId,
    title: input.title,
    body: input.body,
    data: input.payload,
    ts: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "crypto-desk-alerts/1.0",
  };
  if (env.ALERT_WEBHOOK_SIGNING_SECRET) {
    const sig = createHmac("sha256", env.ALERT_WEBHOOK_SIGNING_SECRET).update(body).digest("hex");
    headers["X-Crypto-Desk-Signature"] = `sha256=${sig}`;
  }

  try {
    const res = await fetch(input.webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { channel: "WEBHOOK", ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { channel: "WEBHOOK", ok: true, status: res.status };
  } catch (err) {
    return { channel: "WEBHOOK", ok: false, error: (err as Error).message };
  }
}

export async function dispatchEmail(input: ChannelDispatchInput): Promise<DispatchOutcome> {
  if (!env.RESEND_API_KEY) {
    return { channel: "EMAIL", ok: false, error: "RESEND_API_KEY not configured" };
  }
  if (!input.userEmail) {
    return { channel: "EMAIL", ok: false, error: "user has no email" };
  }
  const from = env.ALERT_EMAIL_FROM ?? "Alphaforge <alerts@example.com>";
  const html = renderEmailHtml(input);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.userEmail],
        subject: `[Alphaforge] ${input.title}`,
        html,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { channel: "EMAIL", ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    return { channel: "EMAIL", ok: true, status: res.status };
  } catch (err) {
    return { channel: "EMAIL", ok: false, error: (err as Error).message };
  }
}

function renderEmailHtml(input: ChannelDispatchInput): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/gu, (c) => {
      switch (c) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        default: return "&#39;";
      }
    });
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background:#0a0a0a; color:#e6e6e6; padding:24px;">
  <div style="max-width:560px; margin:0 auto; background:#141414; border:1px solid #262626; border-radius:12px; padding:20px;">
    <h1 style="font-size:16px; margin:0 0 8px;">${esc(input.title)}</h1>
    <p style="font-size:13px; color:#a8a8a8; margin:0 0 16px;">${esc(input.body)}</p>
    <pre style="font-size:11px; color:#737373; background:#0a0a0a; padding:12px; border-radius:8px; overflow:auto;">${esc(
      JSON.stringify(input.payload, null, 2),
    )}</pre>
  </div>
</body></html>`;
}
