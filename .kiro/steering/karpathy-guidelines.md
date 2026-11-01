# Karpathy-Inspired Coding Guidelines — alpha-forge

> Derived from Andrej Karpathy's observations on LLM coding pitfalls.
> Source: https://github.com/multica-ai/andrej-karpathy-skills
>
> **Tradeoff:** These guidelines bias toward caution over speed.
> For trivial tasks (a typo fix, an obvious one-liner) use judgment.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing anything:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

**In this project specifically:**
- alpha-forge is the **signal consumer and portfolio construction frontend**. It receives signals from ml-service (port 8100) via REST and WebSocket (`WS /v2/stream/signals`), and market data from data-service (port 8200). Changes to how signals are fetched or displayed directly affect live trading decisions.
- Next.js App Router has a clear server/client boundary. Before adding `"use client"` to a component, state why server rendering is insufficient. Before adding a Server Action, confirm no existing API route covers the use case.
- Prisma schema here is **shared with the AlphaForge PostgreSQL stack** — schema changes require `prisma migrate dev` and may affect SentinelPulse as well. Flag this before any schema change.
- Do not assume Redis keys — read `src/lib/redis.ts` and `src/services/india/cache/` first.
- The research module (`src/lib/research/`) contains financial analytics (ablation, decay, overfitting, Monte Carlo). These are quantitative algorithms — state your assumptions about the math before changing them.

---

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: *Would a senior React/Next.js engineer say this is overcomplicated?* If yes, simplify.

**In this project specifically:**
- `src/components/ui/` contains the shared UI primitives (shadcn/ui pattern). Do not create one-off styled wrappers for a single use — extend the existing primitive or use it directly.
- Zustand stores (`src/store/`) are the client state layer. Do not add React Context for state that belongs in a store, and do not add a store for state that is purely local to one component.
- `src/lib/` contains pure logic (market-data, backtesting, research). Keep it framework-agnostic — no React imports in `src/lib/`.
- Do not add new npm dependencies without explicit user approval. This is a large Next.js app with an already-heavy bundle.
- API routes (`src/app/api/`) should be thin: validate → call service/lib → return response. Business logic belongs in `src/lib/` or `src/features/`, not in route handlers.

---

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style (TypeScript strict, Zod validation, Prisma queries, Tailwind classes, named exports).
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/types/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: *Every changed line should trace directly to the user's request.*

**In this project specifically:**
- `src/lib/auth.ts` controls authentication. Do not touch it unless the task is explicitly about auth — a side-effect change here breaks all protected routes.
- `src/lib/env.ts` validates environment variables at startup. Do not add `process.env.*` calls directly in other files — add to `env.ts` and import from there.
- `src/lib/backtesting-v2/` is a multi-file backtesting engine. Do not refactor the adapter/engine/events/execution/models split as a side effect of adding a single feature.
- Worker code in `worker/` (if present) runs in a separate process — changes to shared types used by both Next.js and the worker must be compatible in both contexts.
- `src/lib/constants.ts` is the single source of truth for magic strings and thresholds. Do not hardcode values that belong there.

---

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add a new dashboard widget" → "Component renders correct data in isolation (Vitest), page loads without errors (Playwright @smoke)"
- "Fix a signal calculation bug" → "Write a test with known input → expected output, then make it pass"
- "Add an API route" → "Route returns correct response for happy path and 400 for invalid input — verified by `npm run test:api`"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

**In this project specifically:**
- `npm run check` = lint + typecheck + tests. Run it before and after any change.
- `npm run typecheck` catches Next.js server/client boundary errors and strict TypeScript issues — run it when adding new files.
- Use the correct test command for the scope of change:
  - `npm run test:lib` for pure logic changes
  - `npm run test:api` for API route changes
  - `npm run test:components` for component changes
  - `npm run test:e2e:smoke` for end-to-end critical path
- `prebuild` runs `npm test` automatically — a failing test will block the production build. This is intentional.

---

## Architecture Snapshot

| Layer | Path | Notes |
|-------|------|-------|
| Pages | `src/app/(dashboard)/` | Dashboard routes: signals, futures, options, paper-trading, research, strategy-lab, scalper |
| API Routes | `src/app/api/` | Next.js Route Handlers for signals, sentiment, alerts, trades, experiments |
| Components | `src/components/` | UI primitives (`ui/`) + feature components (`india/`) |
| Features | `src/features/` | Feature-sliced modules: paper-trading, backtesting, strategy-lab, ai-signals |
| Lib | `src/lib/` | Pure logic: backtesting-v2, research (ablation/decay/overfitting/MC), risk, signal-quality |
| Services | `src/services/india/` | Angel One broker, signals, scanner, WebSocket, cache |
| Stores | `src/store/` | Zustand: marketStore, uiStore, liquidationStore |
| Hooks | `src/hooks/` | useLiquidationStream, useBinanceTickers, useBreakpoint |
| DB | `src/lib/prisma.ts` | Prisma client (shared PostgreSQL with AlphaForge stack) |

**Stack:** Next.js 14 · TypeScript strict · Tailwind · Zustand · Prisma · Redis · Vitest · Playwright · Zod
**Consumers:** ml-service (8100) REST + WebSocket · data-service (8200) REST
