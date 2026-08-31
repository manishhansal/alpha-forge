# Implementation Plan: WhatsApp Trading Notifications

## Overview

Implement a self-contained WhatsApp notification channel for the AlphaForge Indian-market trading platform. The feature is additive — all new code lives in `src/features/whatsapp/`, `src/components/settings/`, and `src/app/api/in/whatsapp/`. Existing workers and API routes receive only a single `dispatchWhatsApp(event, userId, deps)` call at their respective trigger points. AES-256-GCM phone encryption reuses the existing crypto path. Cooldown deduplication is enforced via Redis `SET NX EX`. Property-based tests use `fast-check` (install pinned).

**Before any implementation**: create a new Git branch from `master` (e.g. `git checkout -b feat/whatsapp-trading-notifications`).

---

## Tasks

- [x] 1. Bootstrap: branch, environment variables, and project scaffolding
  - Create and check out branch `feat/whatsapp-trading-notifications` from `master`
  - Add `WHATSAPP_EVOLUTION_API_URL` (optional `z.string().url()`), `WHATSAPP_INSTANCE` (optional `z.string()`), and `WHATSAPP_API_KEY` (optional `z.string()`) to the server schema in `src/lib/env.ts`
  - Add a `whatsapp` section with `enabled: boolean` (derived from both URL and instance being set) to `worker/src/config.ts`
  - Add commented entries for all three env vars to `.env.example` with descriptive comments
  - Create the directory scaffold: `src/features/whatsapp/`, `src/features/whatsapp/formatters/`, `src/app/api/in/whatsapp/status/`, `src/app/api/in/whatsapp/test/`, `src/components/settings/` (if absent), `tests/features/whatsapp/`, `tests/features/whatsapp/notifier/`, `tests/api/in/whatsapp/`, `tests/components/settings/whatsapp-section/`
  - Install `fast-check` pinned to its current exact version: `npm install --save-dev fast-check`
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [x] 2. Core types and shared formatter utilities
  - [x] 2.1 Create `src/features/whatsapp/types.ts` with the full `NotificationEvent` union type
    - Define `NotificationEventType` string union
    - Define `DailyPicksEvent`, `AiSignalEvent`, `ScannerHitEvent`, `SignalsBoardEvent`, `PaperTradeEvent` interfaces
    - Export `NotificationEvent` as the discriminated union of all five
    - _Requirements: 4.1, 5.1, 6.1, 7.1, 8.1–8.4_

  - [x] 2.2 Create `src/features/whatsapp/formatters/shared.ts` with all shared helpers
    - Implement `formatINR(price: number, isIndex: boolean): string` — Indian comma grouping, `₹` prefix, decimal handling per instrument type
    - Implement `formatISTDateTime(epochMs: number): string` — UTC+5:30 shift, `DD-Mon-YYYY HH:MM IST` pattern
    - Implement `formatISTTime(epochMs: number): string` — `HH:MM IST` intraday format
    - Implement `formatDuration(fromMs: number, toMs: number): string` — `Xh Ym` pattern
    - Implement `messageFooter(): string` — `AlphaForge • NSE F&O • HH:MM IST`
    - Implement `actionEmoji(action: string): string` — `🟢` for LONG/BUY, `🔴` for SHORT/SELL
    - Implement `isIndexSymbol(symbol: string): boolean` — checks against FNO_INDICES catalog
    - Implement `lotSizeFor(symbol: string): number | undefined`
    - Implement `scannerTypeLabel(type: string): string` — maps internal type keys to human-readable labels
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 5.5, 8.8, 6.4_

  - [ ]* 2.3 Write property test for `formatINR` (Property 5)
    - **Property 5: Indian currency formatter produces correct notation**
    - **Validates: Requirements 9.1, 9.2**
    - File: `tests/features/whatsapp/format-inr.test.ts`
    - Use `fc.float({ min: 0, max: 1_000_000 })` and `fc.boolean()` — verify `₹` prefix, Indian comma grouping, decimal suffix iff `isIndex` is false, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 5: Indian currency formatter produces correct notation`_

  - [ ]* 2.4 Write property test for `formatISTDateTime` (Property 6)
    - **Property 6: IST timestamp formatter round-trips correctly**
    - **Validates: Requirements 4.5, 9.4**
    - File: `tests/features/whatsapp/format-ist.test.ts`
    - Use `fc.integer({ min: Date.UTC(2024,0,1), max: Date.UTC(2034,11,31) })` — verify the time component is exactly UTC+5:30, pattern matches `DD-Mon-YYYY HH:MM IST`, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 6: IST timestamp formatter round-trips correctly`_

  - [ ]* 2.5 Write property test for `actionEmoji` (Property 9)
    - **Property 9: Action emoji maps correctly for all valid action values**
    - **Validates: Requirements 5.5, 8.8**
    - File: `tests/features/whatsapp/action-emoji.test.ts`
    - Use `fc.constantFrom("LONG","BUY","SHORT","SELL")` — verify `🟢` for LONG/BUY, `🔴` for SHORT/SELL, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 9: Action emoji maps correctly for all valid action values`_

  - [ ]* 2.6 Write unit test for `scannerTypeLabel` (Property 11)
    - **Property 11: Scanner type labels are human-readable**
    - **Validates: Requirements 6.4**
    - File: `tests/features/whatsapp/scanner-label.test.ts`
    - For every catalog entry verify return value is non-empty and differs from the raw key string, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 11: Scanner type labels are human-readable`_

- [x] 3. Phone number helpers
  - [x] 3.1 Create `src/features/whatsapp/phone.ts`
    - Export `E164_REGEX = /^\+[1-9]\d{6,14}$/`
    - Implement `validatePhone(phone: string): { ok: boolean; error?: string }` using the regex
    - Implement `encryptPhone(phone: string): EncryptedPayload` — reuse existing AES-256-GCM crypto path (same as exchange API keys)
    - Implement `maskPhone(phone: string): string` — `"+91 98765 •••••"` pattern
    - Implement `readPhone(userId: string): Promise<string | null>` — decrypt from `UserSetting.apiKeysEncrypted["whatsapp"]`; return null if absent or Prisma unavailable
    - Implement `savePhone(userId: string, phone: string): Promise<void>` — encrypt and persist
    - Implement `deletePhone(userId: string): Promise<void>` — remove the `whatsapp` key
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 2.7_

  - [ ]* 3.2 Write property test for `validatePhone` (Property 2)
    - **Property 2: E.164 validation rejects any non-conforming phone string**
    - **Validates: Requirements 2.7**
    - File: `tests/features/whatsapp/phone-validator.test.ts`
    - Use `fc.string()` filtered to exclude E.164 conforming strings — verify `{ ok: false }` for all non-conforming inputs; also verify valid E.164 strings return `{ ok: true }`, numRuns: 200
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 2: E.164 validation rejects any non-conforming phone string`_

- [x] 4. User preferences module
  - [x] 4.1 Create `src/features/whatsapp/preferences.ts`
    - Export `WHATSAPP_EVENT_TYPES` const array with all five event type strings
    - Export `WhatsAppPreferences` interface with `enabledEvents: WhatsAppEventType[]`
    - Implement `getWhatsAppPreferences(userId, prisma?)` — reads `UserSetting.dataSourcesJson.whatsapp.enabledEvents`; defaults to all five types enabled when absent
    - Implement `saveWhatsAppPreferences(userId, prefs, prisma?)` — writes back to `dataSourcesJson` without disturbing other keys
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 5. Per-event message formatters
  - [x] 5.1 Create `src/features/whatsapp/formatters/daily-picks.ts`
    - Implement `formatDailyPicksMessage(event: DailyPicksEvent): string`
    - Include bucket name, rank, symbol, exchange, action, entry `₹`, SL `₹`, target `₹`, can-move-upto `₹`, can-expect %, confidence, grade, logic, lot size for index symbols, IST freeze timestamp in `DD-Mon-YYYY HH:MM IST`, and footer
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 9.1–9.5_

  - [ ]* 5.2 Write property test for `formatDailyPicksMessage` (Properties 4, 15)
    - **Property 4: Daily Picks message contains all required fields**
    - **Property 15: Every formatted message contains the standard footer**
    - **Validates: Requirements 4.2, 4.5, 9.3, 9.5**
    - File: `tests/features/whatsapp/format-daily-picks.test.ts`
    - Use `fc.record` with arbitrary bucket/symbol/price/confidence values — verify all required fields present, `₹` prefixes, `DD-Mon-YYYY HH:MM IST` pattern, footer line, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 4 & 15`_

  - [x] 5.3 Create `src/features/whatsapp/formatters/ai-signal.ts`
    - Implement `formatAiSignalMessage(event: AiSignalEvent): string`
    - Include symbol, action, confidence, grade, entry `₹`, SL `₹`, TP1/TP2/TP3 `₹`, R:R, win-prob %, horizon, top 3 rationale bullets, `actionEmoji` header, strike field for index underlyings, `[ML ✓]` tag when `mlEnhanced: true`, footer
    - _Requirements: 5.2, 5.3, 5.5, 5.6, 9.1–9.5_

  - [ ]* 5.4 Write property test for `formatAiSignalMessage` (Properties 8, 15)
    - **Property 8: AI Signal message contains all required fields**
    - **Property 15: Every formatted message contains the standard footer**
    - **Validates: Requirements 5.2, 9.5**
    - File: `tests/features/whatsapp/format-ai-signal.test.ts`
    - Generate arbitrary `AiSignalEvent` payloads with `action !== "WAIT"` and `confidenceScore >= 60` — verify all fields present, footer present, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 8 & 15`_

  - [x] 5.5 Create `src/features/whatsapp/formatters/scanner.ts`
    - Implement `formatScannerHitMessage(event: ScannerHitEvent): string`
    - Include scanner type label, symbol, exchange, price `₹`, day change %, key metric, footer
    - Implement the batch consolidation path: when more than 5 hits are bundled, emit a single summary listing all symbols
    - _Requirements: 6.2, 6.4, 6.5, 9.1–9.5_

  - [ ]* 5.6 Write property test for `formatScannerHitMessage` (Property 15)
    - **Property 15: Every formatted message contains the standard footer**
    - **Validates: Requirements 9.5**
    - File: `tests/features/whatsapp/format-scanner.test.ts`
    - Verify footer presence for individual hit messages and for the batch summary path, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 15`_

  - [x] 5.7 Create `src/features/whatsapp/formatters/signals-board.ts`
    - Implement `formatSignalsBoardMessage(event: SignalsBoardEvent): string`
    - Include symbol, exchange, source type, direction, price `₹`, day change %, key metric, `HH:MM IST` detection time, footer
    - _Requirements: 7.2, 7.4, 9.1–9.5_

  - [ ]* 5.8 Write property test for `formatSignalsBoardMessage` (Property 15)
    - **Property 15: Every formatted message contains the standard footer**
    - **Validates: Requirements 7.4, 9.5**
    - File: `tests/features/whatsapp/format-signals-board.test.ts`
    - Verify footer presence for arbitrary `SignalsBoardEvent` payloads, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 15`_

  - [x] 5.9 Create `src/features/whatsapp/formatters/paper-trade.ts`
    - Implement `formatPaperTradeMessage(event: PaperTradeEvent): string`
    - `PAPER_TRADE_OPENED`: symbol, exchange, direction, strategy name, entry `₹`, SL `₹`, target `₹`, R:R, `openedAt` IST timestamp, footer
    - `PAPER_TRADE_WIN` / `PAPER_TRADE_LOSS`: symbol, exchange, direction, exit price `₹`, signed P&L % (`+`/`-`), duration `Xh Ym`, `actionEmoji` header, footer
    - `PAPER_TRADE_EXPIRED`: symbol, direction, entry `₹`, final price `₹`, P&L % at expiry, footer
    - _Requirements: 8.5, 8.6, 8.7, 8.8, 9.1–9.5_

  - [ ]* 5.10 Write property tests for `formatPaperTradeMessage` (Properties 13, 14, 15)
    - **Property 13: Paper Trade OPENED message contains all required fields**
    - **Property 14: Paper Trade WIN/LOSS message contains all required fields**
    - **Property 15: Every formatted message contains the standard footer**
    - **Validates: Requirements 8.5, 8.6, 9.5**
    - File: `tests/features/whatsapp/format-paper-trade.test.ts`
    - Test each event type variant — verify required fields and footer for each, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 13, 14 & 15`_

- [x] 6. Checkpoint — ensure formatter suite passes
  - Ensure all formatter and utility tests pass. Run `npm run test:features`. Ask the user if any questions arise.

- [x] 7. Notifier core — dispatch, cooldown gate, and preferences filter
  - [x] 7.1 Create `src/features/whatsapp/notifier.ts` with `dispatchWhatsApp` and `sendEvolutionMessage`
    - Implement `DispatchResult` interface
    - Implement `sendEvolutionMessage(phone, text)` — `POST {URL}/message/sendText/{INSTANCE}`, `apikey` header when `WHATSAPP_API_KEY` set, 8s `AbortController` timeout, single retry after 2s on timeout, structured `log.debug`/`log.warn` on every outcome, `captureException` when Sentry DSN set
    - Implement `dispatchWhatsApp(event, userId, deps?)`:
      1. Guard: return `suppressed: "not-configured"` if `WHATSAPP_EVOLUTION_API_URL` or `WHATSAPP_INSTANCE` missing
      2. Read preferences; return `suppressed: "event-disabled"` if event type not in `enabledEvents`
      3. Read and decrypt phone; return `suppressed: "no-phone"` if absent or Prisma failure
      4. Check Redis cooldown key with `SET NX EX` (see key schema in design); return `suppressed: "cooldown"` if key already set
      5. Format message via the appropriate formatter
      6. Call `sendEvolutionMessage`; update `whatsapp:last-dispatch` Redis key on success
      7. All paths are non-throwing — `.catch` wrapper at the call site handles any residual errors
    - Implement all five Redis cooldown key patterns and TTLs (23h / 1800s / 900s / 1200s / 60s)
    - _Requirements: 1.1–1.7, 2.3, 2.4, 3.3, 4.6, 5.4, 6.3, 7.3, 8.9, 10.1–10.6_

  - [ ]* 7.2 Write property test for non-2xx dispatch failure (Property 1)
    - **Property 1: Non-2xx Evolution API response → failed outcome, no throw**
    - **Validates: Requirements 1.4**
    - File: `tests/features/whatsapp/notifier/notifier-dispatch-failure.test.ts`
    - Use `fc.integer({ min: 400, max: 599 })` to generate HTTP error codes — stub `fetch` to return each status; verify `ok: false`, correct status recorded, no exception thrown, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 1: Non-2xx Evolution API response → failed outcome, no throw`_

  - [ ]* 7.3 Write property test for disabled event suppression (Property 3)
    - **Property 3: Disabled event types are always suppressed**
    - **Validates: Requirements 3.3**
    - File: `tests/features/whatsapp/notifier/notifier-preference-filter.test.ts`
    - For each of the five event types, remove it from `enabledEvents` and verify `suppressed: true`, `suppressReason: "event-disabled"`, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 3: Disabled event types are always suppressed`_

  - [ ]* 7.4 Write property test for cooldown gate (Property 7)
    - **Property 7: Cooldown gate suppresses all duplicate dispatches within TTL**
    - **Validates: Requirements 4.6, 5.4, 6.3, 7.3, 8.9**
    - File: `tests/features/whatsapp/notifier/notifier-cooldown.test.ts`
    - Use `InMemoryRedis` test adapter; after first successful dispatch verify that the second call for the same key returns `suppressed: true, suppressReason: "cooldown"` regardless of payload variation, numRuns: 100
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 7: Cooldown gate suppresses all duplicate dispatches within TTL`_

  - [ ]* 7.5 Write unit tests for env guard paths
    - File: `tests/features/whatsapp/notifier/notifier-env-guards.test.ts`
    - Verify `suppressed: "not-configured"` when `WHATSAPP_EVOLUTION_API_URL` is missing
    - Verify `suppressed: "not-configured"` when `WHATSAPP_INSTANCE` is missing
    - _Requirements: 1.2, 1.3_

- [x] 8. Public barrel and formatter.ts dispatcher
  - [x] 8.1 Create `src/features/whatsapp/formatter.ts`
    - Export `formatDailyPicksMessage`, `formatAiSignalMessage`, `formatScannerHitMessage`, `formatSignalsBoardMessage`, `formatPaperTradeMessage` as top-level re-exports delegating to the per-event formatter modules
    - _Requirements: 4.2, 5.2, 6.2, 7.2, 8.5–8.7_

  - [x] 8.2 Create `src/features/whatsapp/index.ts` public barrel
    - Re-export `dispatchWhatsApp`, `sendEvolutionMessage` from `notifier.ts`
    - Re-export all formatter functions from `formatter.ts`
    - Re-export types from `types.ts`, preferences helpers from `preferences.ts`, phone helpers from `phone.ts`
    - _Requirements: 1.1, 1.7_

- [x] 9. Alert channel registration
  - Modify `src/features/alerts/channels.ts` to add `WHATSAPP` to the `DispatchOutcome` channel union and the `ALERT_CHANNELS` array (alongside `IN_APP`, `EMAIL`, `WEBHOOK`)
  - Modify `src/features/alerts/types.ts` to update `ALERT_CHANNELS` if it is defined there
  - _Requirements: 1.7_

- [x] 10. API routes: status and test
  - [x] 10.1 Create `src/app/api/in/whatsapp/status/route.ts` — `GET /api/in/whatsapp/status`
    - Attempt a lightweight connectivity check to `WHATSAPP_EVOLUTION_API_URL` (e.g. HEAD or GET `/`)
    - Read `whatsapp:last-dispatch` from Redis for last dispatch timestamp
    - Return `{ reachable, instance, lastDispatchAt, configured }` response shape
    - Return `configured: false` and skip connectivity check when env vars are not set
    - _Requirements: 10.5_

  - [x] 10.2 Create `src/app/api/in/whatsapp/test/route.ts` — `POST /api/in/whatsapp/test`
    - Accept `{ userId: string }` body
    - Format and dispatch a test message using `sendEvolutionMessage` directly (bypasses cooldown)
    - Return `{ ok: boolean; message?: string }`
    - _Requirements: 11.5_

  - [ ]* 10.3 Write integration tests for both routes
    - File: `tests/api/in/whatsapp/status.test.ts` — verify `reachable`, `instance`, `configured` fields present; mock `fetch`
    - File: `tests/api/in/whatsapp/test.test.ts` — verify sends real-format test message with mocked `fetch`, returns `{ ok: true }` on 2xx
    - _Requirements: 10.5, 11.5_

- [x] 11. UI: WhatsAppSection component and profile page integration
  - [x] 11.1 Create `src/components/settings/whatsapp-section.tsx`
    - Configuration Banner: shown when `WHATSAPP_EVOLUTION_API_URL` is not set; links to Evolution-Go GitHub
    - Phone Number Form: E.164 input with inline validation error on bad input (`validatePhone`), save action calling `savePhone`, remove action calling `deletePhone`, masked preview (`maskPhone`) when a number is stored
    - WhatsApp Alerts Toggles: five toggle switches for `WHATSAPP_EVENT_TYPES`, persisted via `saveWhatsAppPreferences`
    - Send Test Message button: calls `POST /api/in/whatsapp/test`, shows toast with outcome
    - Use existing shadcn UI primitives; match the existing `ApiKeysForm` component style
    - _Requirements: 2.1, 2.5, 2.6, 2.7, 3.1, 11.1, 11.2, 11.3, 11.5_

  - [x] 11.2 Modify `src/components/settings/api-keys-form.tsx` to render `<WhatsAppSection />` within the API Keys tab
    - Import and render the new component in the appropriate slot
    - _Requirements: 11.1_

  - [x] 11.3 Modify `src/components/settings/alerts-manager.tsx` to add `WHATSAPP` to the channel chips
    - Add `WHATSAPP` alongside `IN_APP`, `EMAIL`, `WEBHOOK` in the channel checkboxes
    - _Requirements: 11.4_

  - [ ]* 11.4 Write component tests for `WhatsAppSection`
    - File: `tests/components/settings/whatsapp-section/whatsapp-section.test.ts`
    - Renders phone input and five toggles
    - Shows config banner when `WHATSAPP_EVOLUTION_API_URL` is not set
    - Shows masked preview when a phone number is stored
    - Displays inline E.164 validation error on bad input (does not submit)
    - Test button calls `/api/in/whatsapp/test` and shows toast
    - _Requirements: 2.1, 2.5, 2.7, 11.1–11.3, 11.5_

- [x] 12. Checkpoint — ensure UI and API route tests pass
  - Run `npm run test:components` and `npm run test:api`. Ensure all new tests pass. Ask the user if any questions arise.

- [x] 13. Worker integrations: Daily Picks and Scalper
  - [x] 13.1 Modify `worker/src/jobs/india-daily-picks.ts` to emit `DAILY_PICKS_NEW` events
    - After `res.persisted === true`, build a `DailyPicksEvent` for each newly frozen bucket
    - Invoke `void dispatchWhatsApp(event, userId, { redis, prisma }).catch(...)` fire-and-forget for each event
    - Gate on `workerConfig.whatsapp.enabled` before calling — no-op when whatsapp is not configured
    - _Requirements: 4.1, 10.3_

  - [x] 13.2 Modify `worker/src/jobs/india-scalper.ts` to emit `PAPER_TRADE_*` events
    - On `in:`-prefixed trade status transition to `OPEN` → emit `PAPER_TRADE_OPENED`
    - On transition to `WIN` → emit `PAPER_TRADE_WIN`
    - On transition to `LOSS` → emit `PAPER_TRADE_LOSS`
    - On transition to `EXPIRED` → emit `PAPER_TRADE_EXPIRED`
    - All dispatches fire-and-forget, gated on `workerConfig.whatsapp.enabled`
    - _Requirements: 8.1–8.4, 10.3_

- [x] 14. API route integrations: AI Signals and Signals Board
  - [x] 14.1 Modify the `GET /api/in/ai-signals` route handler to emit `AI_SIGNAL_NEW` events
    - After `getIndiaAiSignals()` resolves, for each signal with `action !== "WAIT"` and `confidenceScore >= 60`, build an `AiSignalEvent` and call `void dispatchWhatsApp(event, userId, deps).catch(...)`
    - Derive `userId` from the authenticated session (same pattern as other India routes)
    - _Requirements: 5.1, 10.3_

  - [x] 14.2 Modify the `GET /api/in/signals` route handler (Signals Board) to emit `SIGNALS_BOARD_NEW` events
    - After the signals feed is built, compute the 70th-percentile strength threshold across the current feed
    - For each entry above the threshold, build a `SignalsBoardEvent` and call `void dispatchWhatsApp(event, userId, deps).catch(...)`
    - _Requirements: 7.1, 10.3_

  - [ ]* 14.3 Write property test for the 70th-percentile gate (Property 12)
    - **Property 12: Top-70th-percentile gate admits correct entries**
    - **Validates: Requirements 7.1**
    - File: `tests/features/whatsapp/notifier/notifier-percentile-gate.test.ts`
    - Use `fc.array(fc.float({ min: 0, max: 100 }), { minLength: 5 })` — verify only signals strictly above the 70th percentile trigger events; signals at or below do not, numRuns: 200
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 12: Top-70th-percentile gate admits correct entries`_

- [x] 15. Scanner worker integration and delta detection
  - [x] 15.1 Integrate `SCANNER_HIT_NEW` emission into the scanner worker / polling path
    - Store previous scan result set in Redis (key `whatsapp:scanner:prev:{type}`)
    - On each tick, compute the delta: new hits = currentHits − previousHits
    - If delta has > 5 new hits, build a single `ScannerHitEvent` array payload and dispatch a batch summary; otherwise dispatch one `ScannerHitEvent` per new hit
    - Update previous set in Redis after dispatch
    - Gate on `workerConfig.whatsapp.enabled`
    - _Requirements: 6.1, 6.5, 10.3_

  - [ ]* 15.2 Write property test for scanner delta detection (Property 10)
    - **Property 10: Scanner delta detection is correct**
    - **Validates: Requirements 6.1**
    - File: `tests/features/whatsapp/notifier/notifier-scanner-delta.test.ts`
    - Use `fc.uniqueArray(fc.string())` for previous and current hit sets — verify emitted events correspond exactly to currentHits − previousHits, no more, no less, numRuns: 200
    - _Tag: `// Feature: whatsapp-trading-notifications, Property 10: Scanner delta detection is correct`_

- [x] 16. Final checkpoint — full suite green
  - Run `npm test` (full suite). Ensure all new tests pass and no existing tests regressed. Run `npm run check` (lint + typecheck + full test). Ask the user if any questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP — they cover property-based and integration tests
- The feature is entirely additive; no existing API route, worker tick, or Prisma schema changes break backward compatibility
- All call sites use the fire-and-forget pattern: `void dispatchWhatsApp(event, userId, deps).catch(err => log.warn(...))`
- Redis is used best-effort for cooldown: if Redis is unavailable, the cooldown check is bypassed and dispatch proceeds
- `ENCRYPTION_KEY` must be set to a fixed 64-hex value in `tests/setup/vitest.setup.ts` for phone encryption tests
- Phone encryption reuses the existing `encryptApiKey` / `decryptApiKey` path in `src/lib/crypto.ts` — no new crypto primitives
- All Evolution API calls in tests use `vi.stubGlobal("fetch", ...)` — no real network calls
- All Redis calls in tests use the existing `InMemoryRedis` test adapter from `src/lib/redis.ts`
- All Prisma calls in tests use `vi.mock("@/lib/prisma")` with inline mocks matching the `UserSetting` shape
- Each property test file must carry the tag comment: `// Feature: whatsapp-trading-notifications, Property N: {property_text}`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.2"] },
    { "id": 1, "tasks": ["2.3", "2.4", "2.5", "2.6", "3.1", "4.1"] },
    { "id": 2, "tasks": ["3.2", "5.1", "5.3", "5.5", "5.7", "5.9"] },
    { "id": 3, "tasks": ["5.2", "5.4", "5.6", "5.8", "5.10", "7.1"] },
    { "id": 4, "tasks": ["7.2", "7.3", "7.4", "7.5", "8.1"] },
    { "id": 5, "tasks": ["8.2", "9.1"] },
    { "id": 6, "tasks": ["10.1", "10.2", "11.1"] },
    { "id": 7, "tasks": ["10.3", "11.2", "11.3"] },
    { "id": 8, "tasks": ["11.4", "13.1", "13.2"] },
    { "id": 9, "tasks": ["14.1", "14.2", "15.1"] },
    { "id": 10, "tasks": ["14.3", "15.2"] }
  ]
}
```
