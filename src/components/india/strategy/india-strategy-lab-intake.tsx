"use client";

import * as React from "react";
import { Lightbulb, Send, Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/india/ui/button";
import { FNO_INDICES } from "@/lib/india/fno-symbols";

const TEMPLATES = [
  {
    id: "weekly-orb",
    title: "Opening-range breakout · NIFTY weekly options",
    body: "On NIFTY weekly options, mark the high and low between 9:15 and 9:45. Buy ATM CE on a 5m close above the OR-high; buy ATM PE on a close below the OR-low. Stop = OR-mid. Target = 1.5× OR width. Skip on Thursday weekly expiry.",
  },
  {
    id: "vwap-reversion",
    title: "VWAP reversion · BANKNIFTY futures",
    body: "On BANKNIFTY futures, when price stretches > 1.5× ATR(14) above session VWAP and RSI(14) > 70, short with 1× ATR stop and target = VWAP. Mirror for longs below VWAP with RSI < 30. Power Hour only (15:00 – 15:30 IST).",
  },
  {
    id: "iv-crush",
    title: "Expiry IV crush · NIFTY straddle",
    body: "On Thursday weekly expiry, sell an ATM straddle at 10:00 IST if India VIX < 13 and NIFTY 30m ATR is below its 20-day average. Stop at 1.5× initial credit; close at 14:00 IST or 60% premium decay, whichever first.",
  },
  {
    id: "ema-pullback",
    title: "EMA pullback · F&O stock momentum",
    body: "On F&O stocks above their 50 EMA on 15m, wait for a pullback to the 20 EMA with a bullish engulfing candle and volume > 1.5× the 20-bar average. Stop below the engulfing low; target = 2× risk.",
  },
];

const DURATIONS = ["1 week", "1 month", "6 months", "1 year", "5 years"] as const;
const TIMEFRAMES = ["5m", "15m", "1h", "1d"] as const;

export function IndiaStrategyLabIntake() {
  const [symbol, setSymbol] = React.useState<string>("NIFTY");
  const [prompt, setPrompt] = React.useState("");
  const [duration, setDuration] = React.useState<(typeof DURATIONS)[number]>(
    "1 year",
  );
  const [timeframe, setTimeframe] = React.useState<(typeof TIMEFRAMES)[number]>(
    "15m",
  );
  const [stopPct, setStopPct] = React.useState("1.0");
  const [targetPct, setTargetPct] = React.useState("2.0");
  const [submitted, setSubmitted] = React.useState(false);

  const onTemplate = (body: string) => {
    setPrompt(body);
    setSubmitted(false);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          <span className="inline-flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--color-brand)]" />
            Describe a NSE F&amp;O strategy
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Strategy prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder='e.g. "Buy NIFTY ATM CE on a 5m close above session VWAP after a liquidity sweep of the prior swing low. Stop 0.6%, target 1.5%."'
              className="mt-1.5 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-border-strong)]"
            />
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Templates
            </div>
            <div className="mt-1.5 grid gap-2 md:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTemplate(t.body)}
                  className="text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 transition-colors hover:border-[var(--color-border-strong)]"
                >
                  <div className="flex items-start gap-2">
                    <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                    <div>
                      <div className="text-[12px] font-semibold">{t.title}</div>
                      <div className="text-[11px] text-[var(--color-fg-muted)] line-clamp-2">
                        {t.body}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Field label="Underlying">
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm"
              >
                {FNO_INDICES.map((i) => (
                  <option key={i.underlying} value={i.underlying}>
                    {i.name} ({i.underlying})
                  </option>
                ))}
                <option value="RELIANCE">RELIANCE</option>
                <option value="HDFCBANK">HDFCBANK</option>
                <option value="ICICIBANK">ICICIBANK</option>
                <option value="TCS">TCS</option>
                <option value="INFY">INFY</option>
                <option value="SBIN">SBIN</option>
              </select>
            </Field>

            <Field label="Lookback">
              <select
                value={duration}
                onChange={(e) =>
                  setDuration(e.target.value as (typeof DURATIONS)[number])
                }
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm"
              >
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Timeframe">
              <select
                value={timeframe}
                onChange={(e) =>
                  setTimeframe(e.target.value as (typeof TIMEFRAMES)[number])
                }
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm"
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Stop / Target %">
              <div className="flex gap-2">
                <input
                  value={stopPct}
                  onChange={(e) => setStopPct(e.target.value)}
                  className="w-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm tabular"
                  placeholder="1.0"
                />
                <input
                  value={targetPct}
                  onChange={(e) => setTargetPct(e.target.value)}
                  className="w-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-1.5 text-sm tabular"
                  placeholder="2.0"
                />
              </div>
            </Field>
          </div>

          <div className="flex items-center justify-between gap-3">
            <Badge variant="info">
              Backtester ships next — your prompt is captured locally meanwhile
            </Badge>
            <Button type="submit" size="sm" disabled={prompt.trim().length < 8}>
              <Send className="h-3 w-3 mr-1" />
              Save draft
            </Button>
          </div>

          {submitted && (
            <div className="rounded-lg border border-[var(--color-bull)] bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)] p-3 text-[12px] text-[var(--color-bull)]">
              Draft captured locally for <strong>{symbol}</strong> ·{" "}
              <strong>{timeframe}</strong> · lookback{" "}
              <strong>{duration}</strong> · stop{" "}
              <strong>{stopPct}%</strong> · target{" "}
              <strong>{targetPct}%</strong>. We&apos;ll wire this through the
              real backtester as soon as the F&amp;O AST parser ships.
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
