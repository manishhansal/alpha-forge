import { Suspense } from "react";

import { CurrencyTabs } from "@/components/options/currency-tabs";
import { ExpiryTable } from "@/components/options/expiry-table";
import { IvStrip } from "@/components/options/iv-strip";
import { PcrCard } from "@/components/options/pcr-card";
import { StrikeOiTable } from "@/components/options/strike-oi-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getOptionsOverview } from "@/features/options/fetch-options";
import type { OptionsCurrency } from "@/types/market";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Options" };

interface OptionsPageProps {
  searchParams: Promise<{ currency?: string }>;
}

function parseCurrency(raw: string | undefined): OptionsCurrency {
  if (raw === "ETH" || raw === "SOL" || raw === "BTC") return raw;
  return "BTC";
}

async function OptionsContent({ currency }: { currency: OptionsCurrency }) {
  const data = await getOptionsOverview(currency);
  const nearestExpiry = data.expiries[0];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <PcrCard
          pcrOi={data.pcrOi}
          pcrVolume={data.pcrVolume}
          totalCallOi={data.totalCallOi}
          totalPutOi={data.totalPutOi}
          totalCallVolume={data.totalCallVolume}
          totalPutVolume={data.totalPutVolume}
        />
        <Card>
          <CardHeader>
            <CardTitle>Spot Reference</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="num text-2xl font-semibold tracking-tight">
              ${data.underlyingPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-fg-muted)]">
              Deribit {currency}-USD index · updated {new Date(data.generatedAt).toLocaleTimeString()}
            </p>
          </CardContent>
        </Card>
      </div>

      <IvStrip expiries={data.expiries} />
      <ExpiryTable expiries={data.expiries} underlyingPrice={data.underlyingPrice} />
      {nearestExpiry ? (
        <StrikeOiTable expiry={nearestExpiry} underlyingPrice={data.underlyingPrice} />
      ) : null}
    </>
  );
}

function OptionsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <Skeleton className="h-[180px] w-full rounded-xl" />
        <Skeleton className="h-[180px] w-full rounded-xl" />
      </div>
      <Skeleton className="h-[200px] w-full rounded-xl" />
      <Skeleton className="h-[300px] w-full rounded-xl" />
      <Skeleton className="h-[420px] w-full rounded-xl" />
    </div>
  );
}

export default async function OptionsPage({ searchParams }: OptionsPageProps) {
  const sp = await searchParams;
  const currency = parseCurrency(sp.currency);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Options · {currency}</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Deribit-powered chain summary — PCR, max pain, ATM IV, and strike-wise open interest.
          </p>
        </div>
        <CurrencyTabs active={currency} />
      </header>

      <Suspense key={currency} fallback={<OptionsSkeleton />}>
        <OptionsContent currency={currency} />
      </Suspense>
    </div>
  );
}
