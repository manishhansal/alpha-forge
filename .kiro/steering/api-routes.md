---
inclusion: fileMatch
fileMatchPattern: "src/app/api/**"
---

# API Routes — Karpathy Guidelines (Service-Specific)

> Applies on top of `karpathy-guidelines.md` when working in `src/app/api/`.

## Think Before Coding

- Next.js Route Handlers run on the server. Before adding a new route, check whether the data is already fetched by an existing route or a Server Component — duplicate fetches waste backend resources.
- Routes in `src/app/api/signals/`, `src/app/api/ai-signals/`, and `src/app/api/sentiment/` are downstream of ml-service (8100) and SentinelPulse (3001). Any change to how these routes call upstream services must respect the upstream API contract (X-API-KEY auth, correct path prefix).
- `src/app/api/auth/` uses NextAuth — do not add custom session logic outside of it. State which NextAuth callback you're modifying before proceeding.
- The `src/app/api/v1/` path suggests a versioned API. Before adding a route to the unversioned path, confirm it doesn't belong under `/v1/`.

## Simplicity First

- Route handlers should be thin: parse request → call `src/lib/` or `src/services/` → return response. Do not put business logic inline in route files.
- Zod is the validation layer for request bodies. Do not add manual `if (!body.field)` checks — write a Zod schema.
- Do not add Redis caching directly in route handlers — use `src/services/india/cache/` which handles TTL and key namespacing.

## Surgical Changes

- `src/app/api/trades/` and `src/app/api/signals/` write to the Prisma database. Do not add DB writes to routes that are currently read-only without flagging the change.
- Do not change HTTP method (GET/POST/PUT) of an existing route — it's a breaking change for the UI component calling it.

## Goal-Driven Execution

- For new routes: success = route returns correct JSON for happy path + 400/422 for invalid input, verified by `npm run test:api`.
- For routes that call ml-service or data-service: success = the outbound call uses the correct base URL from `src/lib/env.ts`, with correct auth headers, verified by a vitest mock.
