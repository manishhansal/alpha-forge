/**
 * Angel One (SmartAPI) connectivity check — one-shot.
 *
 * Verifies, in order:
 *   1. Credentials are present in the environment.
 *   2. SmartAPI login succeeds (TOTP + PIN → JWT).
 *   3. getCandleData returns candles for a liquid symbol (RELIANCE).
 *
 * It prints a clear PASS/FAIL for each stage and, on failure, the exact
 * upstream error (e.g. "HTTP 403", "Invalid TOTP") so you know whether the
 * problem is credentials, TOTP drift, or an IP/WAF block.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/verify-angelone.ts
 *
 * Fill these in .env.local first:
 *   SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PIN, SMARTAPI_TOTP_SECRET
 *   SMARTAPI_PUBLIC_IP=<your public IP>   (curl -s https://api.ipify.org)
 */
// This is a developer verification script — not production code.
// See DATA_SERVICE_PRE_REFACTOR_AUDIT.md for documented exceptions.
// eslint-disable-next-line no-restricted-imports
import { angel, isAngelConfigured } from "@/services/india/angelone";

function line(label: string, ok: boolean, detail = ""): void {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  console.log("=== Angel One SmartAPI verification ===\n");

  // Stage 1: credentials present?
  const configured = isAngelConfigured();
  line(
    "credentials present in env",
    configured,
    configured
      ? "SMARTAPI_* all set"
      : "one or more of SMARTAPI_API_KEY / CLIENT_CODE / PIN / TOTP_SECRET is empty",
  );
  if (!configured) {
    console.log(
      "\nFill the SMARTAPI_* vars in .env.local, then re-run. Aborting.",
    );
    process.exit(1);
  }

  const pubIp = process.env.SMARTAPI_PUBLIC_IP;
  line(
    "SMARTAPI_PUBLIC_IP set",
    !!pubIp && pubIp !== "127.0.0.1",
    pubIp
      ? `= ${pubIp}`
      : "unset — SmartAPI will send 127.0.0.1, which can trigger a WAF 403",
  );

  // Stage 2 + 3: a real ranged intraday candle fetch exercises login + getCandleData.
  console.log("\nFetching RELIANCE 5m candles (last ~5 days)…");
  try {
    const candles = await angel.getHistorical(
      { symbol: "RELIANCE", interval: "5m", range: "5d" },
      { allowFallback: false }, // strict — no Yahoo backfill, so we see the real Angel result
    );
    if (candles.length > 0) {
      const first = candles[0]!;
      const last = candles[candles.length - 1]!;
      line("login + getCandleData", true, `${candles.length} candles`);
      console.log(
        `      first: ${new Date(first.time * 1000).toISOString()} close=${first.close}`,
      );
      console.log(
        `      last:  ${new Date(last.time * 1000).toISOString()} close=${last.close}`,
      );
      console.log("\nAngel One is working. ✅");
    } else {
      line(
        "getCandleData",
        false,
        "returned 0 candles (market may be closed, or the symbol/interval window was empty)",
      );
      console.log(
        "\nLogin likely succeeded but no candles came back. Re-run during market hours " +
          "(09:15–15:30 IST) to confirm data flows.",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line("login / getCandleData", false, msg);
    if (msg.includes("403") || msg.toLowerCase().includes("forbidden")) {
      console.log(
        "\nHTTP 403 = Angel's Akamai gateway blocked the request. Set SMARTAPI_PUBLIC_IP " +
          "to your real egress IP and retry; if it persists, the IP is WAF-flagged.",
      );
    } else if (msg.toLowerCase().includes("totp") || msg.toLowerCase().includes("invalid")) {
      console.log(
        "\nLooks like a login/TOTP problem — check SMARTAPI_TOTP_SECRET (base32 from the QR) " +
          "and that your device clock is accurate.",
      );
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[verify-angelone] unexpected error:", e);
  process.exit(1);
});
