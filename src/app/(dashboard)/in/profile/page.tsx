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
export const metadata = { title: "Profile · NSE F&O" };

/**
 * NSE F&O flavour of the consolidated profile page. Reuses the same
 * account / data sources / API keys / alerts components as the crypto
 * surface — settings are user-scoped, not market-scoped — but tightens
 * the copy around India broker selection (Yahoo / NSE proxy / Groww),
 * weekly-expiry IV alerts and the cookie-warmed NSE option chain.
 */
export default async function IndiaProfilePage() {
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
        <h1 className="text-xl font-semibold tracking-tight">Profile · NSE F&amp;O</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Identity, India-broker selection (Yahoo / NSE / Groww), API keys
          and alerts. Profile is user-scoped and shared across the crypto
          and NSE F&amp;O surfaces.
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
                India broker &amp; crypto data sources
              </CardTitle>
              <CardDescription>
                For NSE F&amp;O the dashboard supports Yahoo Finance
                (default, no-key), the cookie-warmed NSE proxy (option
                chains), and Groww REST (opt-in via API key). Pick one or
                many — the primary source serves the live feed and the
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
                  Broker &amp; exchange API keys
                </CardTitle>
                <CardDescription>
                  Encrypted at rest with AES-256-GCM. Read-only keys are
                  strongly recommended — the dashboard never needs
                  withdrawal or order permissions. India-side, only Groww
                  requires a key; Yahoo and the NSE proxy are public.
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
                cooldown window. India-specific alert templates (PCR
                extremes, ATM IV spikes, weekly-expiry guardrails) ship
                alongside the F&amp;O scalper.
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
