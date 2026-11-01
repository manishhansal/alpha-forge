---
inclusion: fileMatch
fileMatchPattern: "src/{lib,services,types}/**"
---

# Lib, Services & Research — Karpathy Guidelines (Service-Specific)

> Applies on top of `karpathy-guidelines.md` when working in `src/lib/`, `src/services/`, or `src/types/`.

## Think Before Coding

- `src/lib/research/` contains quantitative financial algorithms: ablation, alpha decay, overfitting detection, Monte Carlo, correlation, hypothesis testing. These are not general-purpose utilities — they implement specific statistical methods. State your assumption about the math (e.g., the decay model, the overfitting criterion) before changing any formula.
- `src/lib/backtesting-v2/` is a multi-component backtesting engine (adapter, analytics, engine, events, execution, models). Before changing the engine core, state which component you're touching and whether the change affects the execution model or just analytics.
- `src/lib/risk/` — risk calculations drive live paper trading decisions in alpha-forge. Changes here have the same gravity as changes to ml-service's DrawdownManager.
- `src/services/india/angelone/` calls the Angel One broker API. This involves live order submission for paper trades. Treat it like production broker code — state your assumption about the API call semantics before changing it.

## Simplicity First

- `src/lib/` is framework-agnostic — no React imports, no Next.js-specific code. Keep it that way.
- `src/lib/signal-intelligence/` and `src/lib/signal-quality/` have overlapping-sounding names. Check `src/lib/signal-intelligence/` before adding logic to `src/lib/signal-quality/` to avoid duplication.
- `src/services/india/signals/` is the signal aggregation layer. Do not add signal processing logic directly in API routes.

## Surgical Changes

- `src/lib/research/` is used by the strategy-lab and research dashboard. Do not change function signatures as a side effect — alpha-forge pages depend on them.
- `src/lib/constants.ts` is the canonical source for all magic numbers and strings. Do not hardcode thresholds inline in lib functions — add them to constants and import.
- `src/types/market.ts` and `src/types/ai-signals.ts` are shared type definitions. Renaming or removing a field is a breaking change across components, stores, and lib.

## Goal-Driven Execution

- For research algorithm changes: success = algorithm produces correct output for a known-good fixture (e.g., a known IC sequence → expected decay output), verified by `npm run test:lib`.
- For backtesting changes: success = backtest produces the same P&L for a replay of a known trade sequence, verified by `npm run test:lib`.
- For broker service changes: success = broker service calls the correct Angel One endpoint with correct payload, handles error responses, verified by vitest with HTTP mocks.
- Run `npm run typecheck` after any type definition change — strict TypeScript will catch consumer mismatches immediately.
