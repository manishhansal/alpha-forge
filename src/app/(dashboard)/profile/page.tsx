import { AlertsManager } from "@/components/settings/alerts-manager";
import { ApiKeysForm } from "@/components/settings/api-keys-form";
import { DataSourcesForm } from "@/components/settings/data-sources-form";
import { ProfileHeader } from "@/components/profile/profile-header";
import { ProfileTabs } from "@/components/profile/profile-tabs";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsForm } from "@/components/settings/settings-form";
import { getCurrentUser } from "@/features/auth/session";
import { listStoredKeys } from "@/features/settings/api-keys";
import { getDataSourceSelections } from "@/features/settings/data-sources";
import { encryptionAvailable } from "@/lib/crypto";
import { getPrisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profile" };

/**
 * /profile is the consolidated home for everything user-scoped — identity,
 * trading preferences, broker / exchange data sources, encrypted API keys
 * and alert rules. It replaces the standalone /settings surface; the old
 * route now permanently redirects here so any bookmarks keep working.
 *
 * Tabs are URL-hash driven (e.g. `/profile#api-keys`) so the topbar avatar
 * can deep-link straight into a specific section, and so users can share
 * a link that lands on the exact tab they were on.
 */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  const encOk = encryptionAvailable();
  const prisma = getPrisma();
  const [storedKeys, dataSources, meta] = await Promise.all([
    listStoredKeys(user.id),
    getDataSourceSelections(user.id),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { createdAt: true },
    }),
  ]);
  const credentialedIds = storedKeys.map((k) => k.exchange);
  const createdAtIso = (meta?.createdAt ?? new Date()).toISOString();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Identity, trading preferences, data sources, exchange API keys and
          alerts — all in one place.
        </p>
      </header>

      <ProfileHeader
        email={user.email}
        name={user.name}
        defaultPair={user.setting.defaultPair}
        hasApiKeys={user.setting.hasApiKeys}
        createdAt={createdAtIso}
      />

      <ProfileTabs
        account={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                Account
              </CardTitle>
              <CardDescription>Profile and trading preferences.</CardDescription>
            </CardHeader>
            <CardContent>
              <SettingsForm
                initial={{
                  email: user.email,
                  name: user.name,
                  defaultPair: user.setting.defaultPair,
                  theme: user.setting.theme,
                }}
              />
            </CardContent>
          </Card>
        }
        dataSources={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                Data sources
              </CardTitle>
              <CardDescription>
                Pick which brokers stream the dashboard&apos;s quotes,
                history, option chain and OI for each market. Pick one or
                more — the primary source serves the live feed and the
                others act as fallbacks.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataSourcesForm
                initial={dataSources}
                credentialedIds={credentialedIds}
              />
            </CardContent>
          </Card>
        }
        apiKeys={
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                  Exchange API keys
                </CardTitle>
                <CardDescription>
                  Encrypted at rest with AES-256-GCM using a server-side
                  key. Read-only keys are strongly recommended — Crypto
                  Desk never needs withdrawal permissions.
                </CardDescription>
              </div>
              <Badge variant={storedKeys.length > 0 ? "bull" : "outline"}>
                {storedKeys.length > 0
                  ? `${storedKeys.length} configured`
                  : "None"}
              </Badge>
            </CardHeader>
            <CardContent>
              <ApiKeysForm encryptionAvailable={encOk} stored={storedKeys} />
            </CardContent>
          </Card>
        }
        alerts={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
                Alerts
              </CardTitle>
              <CardDescription>
                Funding spike, OI breakout, price breakout, liquidation
                surge, signal change. Each alert fires at most once per
                cooldown window.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AlertsManager />
            </CardContent>
          </Card>
        }
      />
    </div>
  );
}
