---
inclusion: fileMatch
fileMatchPattern: "src/{components,features,hooks,store}/**"
---

# Components, Features & Stores — Karpathy Guidelines (Service-Specific)

> Applies on top of `karpathy-guidelines.md` when working in `src/components/`, `src/features/`, `src/hooks/`, or `src/store/`.

## Think Before Coding

- The `src/components/india/` sub-tree contains NSE-specific UI. Changes here affect the live trading dashboard — state what data the component displays and where it comes from before modifying render logic.
- The `src/components/india/smc-scanner/` components display SMC scanner results from ml-service (`/v2/scanners/registry`). Before changing how scanner data is rendered, confirm the data shape from the API hasn't changed.
- Zustand stores (`src/store/marketStore.ts`, `uiStore.ts`, `liquidationStore.ts`) are shared across the whole app. A store action change affects every component that subscribes — list the subscribers before modifying store shape.
- `src/hooks/useLiquidationStream.ts` and `useBinanceTickers.ts` manage live WebSocket connections. Do not add a second WebSocket hook for the same stream — extend the existing one.

## Simplicity First

- `src/components/ui/` follows the shadcn/ui pattern. Do not create one-off styled components for a single page — use or extend the existing primitives.
- Feature modules in `src/features/` co-locate components, hooks, and logic for a feature. Do not add a component to `src/components/` if it is only used by one feature module.
- React Server Components (no `"use client"`) are preferred for read-only data display. Only add `"use client"` when interactivity (onClick, useState, useEffect) is genuinely required.
- Do not add animation libraries — `src/lib/motion-presets.ts` already provides Framer Motion presets.

## Surgical Changes

- Do not rename store fields that are persisted to localStorage (if any) — it silently breaks users' saved state.
- `src/components/india/paper-trading/` drives the paper trading interface. Do not change component prop contracts here as a side effect of styling work.
- `src/features/india/paper-trading/` and `src/features/india/expiry-trades/` touch live paper positions — UI changes here can affect paper trade recording.

## Goal-Driven Execution

- For component changes: success = component renders correct output for all data states (loading, error, empty, populated), verified by `npm run test:components`.
- For store changes: success = actions produce the correct state transitions for all defined actions, verified by `npm run test:stores`.
- For hook changes: success = hook returns the correct values for mock WebSocket/API inputs, verified by `npm run test:hooks`.
- For visual changes: run `npm run test:e2e:smoke` to verify critical UI paths still load.
