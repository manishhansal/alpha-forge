"use client";

import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useActionState, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type DataSourcesActionResult,
  saveDataSourcesAction,
} from "@/features/settings/data-sources-actions";
import {
  DATA_SOURCES_BY_ID,
  INDIA_OI_SOURCES,
  dataSourcesFor,
  type DataSourceId,
  type DataSourceSelections,
} from "@/features/settings/data-sources-shared";
import { EXCHANGE_LABELS } from "@/features/settings/api-keys-shared";

interface Props {
  initial: DataSourceSelections;
  /** Ids of brokers the user has API keys saved for — drives the "Key on
   *  file" badge so the user doesn't have to bounce between cards. */
  credentialedIds: readonly string[];
}

export function DataSourcesForm({ initial, credentialedIds }: Props) {
  const [india, setIndia] = useState<DataSourceId[]>(initial.india.selected);
  const [indiaOi, setIndiaOi] = useState<DataSourceId>(initial.india.optionChain);
  const [crypto, setCrypto] = useState<DataSourceId[]>(initial.crypto.selected);
  const [cryptoPrimary, setCryptoPrimary] = useState<DataSourceId>(
    initial.crypto.primary,
  );

  const [state, action, pending] = useActionState<
    DataSourcesActionResult | undefined,
    FormData
  >(saveDataSourcesAction, undefined);

  const credSet = useMemo(() => new Set(credentialedIds), [credentialedIds]);

  const toggle = (
    list: DataSourceId[],
    set: (next: DataSourceId[]) => void,
    id: DataSourceId,
  ) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  // OI picker should only offer sources actually selected for India + always
  // valid OI providers (NSE is the global default fallback).
  const oiOptions = useMemo<DataSourceId[]>(() => {
    const inUse = INDIA_OI_SOURCES.filter((id) => india.includes(id));
    return inUse.length > 0 ? inUse : ["nse"];
  }, [india]);

  // Same for the crypto primary feed picker.
  const primaryOptions = useMemo<DataSourceId[]>(
    () => (crypto.length > 0 ? crypto : (["delta"] as DataSourceId[])),
    [crypto],
  );

  // Snap the dropdowns to a valid value when the underlying checkbox set
  // shrinks. We *derive* the effective value during render rather than
  // syncing stored state in a useEffect (which would trigger a cascading
  // render and flag `react-hooks/set-state-in-effect`). The controlled
  // <select> always shows a valid option, and the form submit reads the
  // displayed value straight off the DOM — so the user's stored
  // preference can stay stale until they actively pick a new one.
  const effectiveIndiaOi: DataSourceId = oiOptions.includes(indiaOi)
    ? indiaOi
    : oiOptions[0];
  const effectiveCryptoPrimary: DataSourceId = primaryOptions.includes(
    cryptoPrimary,
  )
    ? cryptoPrimary
    : primaryOptions[0];

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      <Section
        market="india"
        title="Indian Market"
        description="Pick one or more brokers for NSE F&O quotes, history, and OI. OI / option-chain calls always use a broker that actually publishes the chain (NSE, BSE or Groww)."
        selected={india}
        onToggle={(id) => toggle(india, setIndia, id)}
        credSet={credSet}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <label
            htmlFor="india-oc"
            className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]"
          >
            Option chain / OI source
          </label>
          <select
            id="india-oc"
            name="indiaOptionChain"
            value={effectiveIndiaOi}
            onChange={(e) => setIndiaOi(e.target.value as DataSourceId)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-xs text-[var(--color-fg)] focus:border-[var(--color-border-strong)] focus:outline-none"
          >
            {oiOptions.map((id) => (
              <option key={id} value={id}>
                {DATA_SOURCES_BY_ID[id].label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-[var(--color-fg-subtle)]">
            Yahoo never publishes OI — these three are the only valid choices.
          </span>
        </div>
      </Section>

      <Section
        market="crypto"
        title="Crypto"
        description="Choose your spot/perp data providers. The primary feed owns the live WebSocket; the others can be queried on demand."
        selected={crypto}
        onToggle={(id) => toggle(crypto, setCrypto, id)}
        credSet={credSet}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <label
            htmlFor="crypto-primary"
            className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)]"
          >
            Primary live feed
          </label>
          <select
            id="crypto-primary"
            name="cryptoPrimary"
            value={effectiveCryptoPrimary}
            onChange={(e) => setCryptoPrimary(e.target.value as DataSourceId)}
            className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 text-xs text-[var(--color-fg)] focus:border-[var(--color-border-strong)] focus:outline-none"
          >
            {primaryOptions.map((id) => (
              <option key={id} value={id}>
                {DATA_SOURCES_BY_ID[id].label}
              </option>
            ))}
          </select>
        </div>
      </Section>

      {/* Hidden inputs render the multi-select for the server action since
          <input type=checkbox name=india> with the same name produces a list. */}
      {india.map((id) => (
        <input key={`h-i-${id}`} type="hidden" name="india" value={id} />
      ))}
      {crypto.map((id) => (
        <input key={`h-c-${id}`} type="hidden" name="crypto" value={id} />
      ))}

      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-[var(--color-fg-subtle)]">
          Changes apply to every page on the next data refresh — no reload needed.
        </div>
        <div className="flex items-center gap-3">
          {state?.error ? (
            <p
              role="alert"
              className="rounded-md border border-[color-mix(in_oklch,var(--color-bear)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_10%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-bear)]"
            >
              {state.error}
            </p>
          ) : null}
          {state?.ok ? (
            <p className="rounded-md border border-[color-mix(in_oklch,var(--color-bull)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)] px-3 py-1.5 text-[12px] text-[var(--color-bull)]">
              Saved.
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {pending ? "Saving…" : "Save sources"}
          </Button>
        </div>
      </div>
    </form>
  );
}

interface SectionProps {
  market: "india" | "crypto";
  title: string;
  description: string;
  selected: DataSourceId[];
  onToggle: (id: DataSourceId) => void;
  credSet: Set<string>;
  children?: React.ReactNode;
}

function Section({
  market,
  title,
  description,
  selected,
  onToggle,
  credSet,
  children,
}: SectionProps) {
  const list = dataSourcesFor(market);
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4">
      <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
        {title}
      </legend>
      <p className="-mt-1 text-[12px] text-[var(--color-fg-muted)]">
        {description}
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {list.map((src) => {
          const isOn = selected.includes(src.id);
          const disabled = !src.implemented;
          const hasKey = credSet.has(src.id);
          return (
            <label
              key={src.id}
              className={[
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                disabled
                  ? "cursor-not-allowed opacity-55"
                  : "hover:border-[var(--color-border-strong)]",
                isOn
                  ? "border-[color-mix(in_oklch,var(--color-brand)_45%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-brand)_8%,transparent)]"
                  : "border-[var(--color-border)] bg-[var(--color-surface)]",
              ].join(" ")}
            >
              <input
                type="checkbox"
                disabled={disabled}
                checked={isOn}
                onChange={() => onToggle(src.id)}
                className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface)] accent-[var(--color-brand)] disabled:cursor-not-allowed"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-[var(--color-fg)]">
                    {src.label}
                  </span>
                  {!src.implemented ? (
                    <Badge variant="outline">Coming soon</Badge>
                  ) : null}
                  {src.requiresApiKey ? (
                    hasKey ? (
                      <Badge variant="bull">
                        <KeyRound className="h-2.5 w-2.5" />
                        Key on file
                      </Badge>
                    ) : (
                      <Badge variant="warning">
                        <KeyRound className="h-2.5 w-2.5" />
                        API key required
                      </Badge>
                    )
                  ) : null}
                  <a
                    href={src.homeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                    aria-label={`${src.label} website`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="text-[11px] text-[var(--color-fg-muted)]">
                  {src.blurb}
                </p>
                {src.requiresApiKey && !hasKey ? (
                  <p className="text-[11px] text-[var(--color-fg-subtle)]">
                    Add a key in the{" "}
                    <span className="font-semibold">
                      {EXCHANGE_LABELS[src.id as keyof typeof EXCHANGE_LABELS] ?? src.label}
                    </span>{" "}
                    row of the Exchange API keys card below.
                  </p>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>
      {children}
    </fieldset>
  );
}
