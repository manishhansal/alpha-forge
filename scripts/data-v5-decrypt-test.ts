/**
 * data-v5-decrypt-test.ts — read-only. Verifies the stored broker credentials
 * can be DECRYPTED by the runtime (worker-style, no session). Prints ONLY
 * boolean/length/last-char-count metadata — NEVER secret values.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const { encryptionAvailable } = await import("../src/lib/crypto");
  const { readAngelCredentials, readUpstoxCredentials } = await import("../src/features/settings/api-keys");

  const out: Record<string, unknown> = {
    queriedAt: new Date().toISOString(),
    encryptionAvailable: encryptionAvailable(),
  };

  // Resolve the owning userId WITHOUT a session (worker-style).
  const settings = await prisma.userSetting.findMany({ select: { userId: true, apiKeysEncrypted: true } });
  const setting = settings.find((s) => s.apiKeysEncrypted && typeof s.apiKeysEncrypted === "object") ?? null;
  out.resolvedUserId = setting ? setting.userId.slice(0, 6) + "…" : null;

  if (setting) {
    try {
      const angel = await readAngelCredentials(setting.userId);
      out.angel = angel
        ? { decrypted: true, apiKeyLen: angel.apiKey.length, clientCodeLen: angel.clientCode.length, hasPin: angel.pin.length > 0, hasTotp: angel.totpSecret.length > 0 }
        : { decrypted: false, reason: "no complete angel entry" };
    } catch (e) { out.angel = { decrypted: false, error: (e as Error).message }; }

    try {
      const up = await readUpstoxCredentials(setting.userId);
      out.upstox = up ? { decrypted: true, analyticsTokenLen: up.analyticsToken.length } : { decrypted: false };
    } catch (e) { out.upstox = { decrypted: false, error: (e as Error).message }; }
  }

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
