/**
 * data-v5-credential-probe.ts — read-only. Determines whether broker credentials
 * exist in the DB frontend store (UserSetting.apiKeysEncrypted / dataSourcesJson)
 * vs .env. Reports PRESENCE + key names ONLY — never secret values.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const out: Record<string, unknown> = { queriedAt: new Date().toISOString() };

  const users = await prisma.user.count();
  const settings = await prisma.userSetting.findMany({
    select: { userId: true, apiKeysEncrypted: true, dataSourcesJson: true },
  });

  out.userCount = users;
  out.userSettingRows = settings.length;

  out.perUser = settings.map((s) => {
    const apiKeys = s.apiKeysEncrypted as Record<string, unknown> | null;
    const dataSources = s.dataSourcesJson as Record<string, unknown> | null;
    // key names only — never values.
    const apiKeyNames = apiKeys && typeof apiKeys === "object" ? Object.keys(apiKeys) : [];
    // For each stored key, report shape (keys of the nested object) not values.
    const apiKeyShapes: Record<string, string[]> = {};
    for (const k of apiKeyNames) {
      const v = (apiKeys as Record<string, unknown>)[k];
      apiKeyShapes[k] = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : [typeof v];
    }
    return {
      userId: s.userId.slice(0, 6) + "…",
      apiKeysEncrypted_present: !!apiKeys,
      apiKeysEncrypted_keys: apiKeyNames,
      apiKeysEncrypted_shapes: apiKeyShapes,
      dataSourcesJson_present: !!dataSources,
      dataSourcesJson_keys: dataSources ? Object.keys(dataSources) : [],
    };
  });

  // Env presence (names only).
  const envVars = ["SMARTAPI_API_KEY","SMARTAPI_CLIENT_CODE","SMARTAPI_PIN","SMARTAPI_TOTP_SECRET","UPSTOX_ANALYTICS_TOKEN","UPSTOX_ACCESS_TOKEN","UPSTOX_CLIENT_ID","UPSTOX_CLIENT_SECRET"];
  out.env = Object.fromEntries(envVars.map((v) => [v, !!(process.env[v] && process.env[v]!.trim())]));

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
