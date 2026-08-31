# Requirements Document

## Introduction

This feature adds a WhatsApp notification channel to the AlphaForge trading platform. Whenever actionable trading events occur on the Indian Market (NSE/BSE F&O) surface — a new Daily Pick, a new AI Signal, a new Signals board entry, a new Scanner result, or a Paper Trading position event — a formatted WhatsApp message is dispatched to the configured user phone number. Messages are formatted for Indian market context (₹ prices, NSE/BSE exchange labels, IST timestamps, lot sizes) and delivered via the Evolution-Go free WhatsApp gateway.

---

## Glossary

- **WhatsApp_Notifier**: The server-side module responsible for formatting and dispatching WhatsApp messages via the Evolution-Go API.
- **Evolution_API**: The Evolution-Go WhatsApp gateway REST API (`https://github.com/evolution-foundation/evolution-go`) running at a configurable `WHATSAPP_EVOLUTION_API_URL` endpoint. Receives message payloads at `POST /message/sendText/{instance}`.
- **Instance**: An Evolution-Go session identifier string (`WHATSAPP_INSTANCE`) representing an authenticated WhatsApp connection on the gateway.
- **Notification_Event**: A structured payload emitted by the AlphaForge platform whenever a trigger condition is met. Each event carries an `eventType`, symbol, exchange, price levels (₹), and metadata.
- **Daily_Pick**: A frozen intraday signal on `/in/daily-picks` — one row in the `IndiaDailyPick` table per bucket (INDICES_SCALP, OPENING_BREAKOUT, MOMENTUM, SCALPING, POTENTIAL), ranked 1–3 within the bucket.
- **AI_Signal**: A multi-confluence AI-generated trade plan produced by `getIndiaAiSignals()`, carrying action, confidence, entry/SL/TP levels, and a rationale.
- **Scanner_Signal**: A hit returned by `/api/in/scanner` from any of the six F&O scanner types (range-expansion, momentum, volume-breakout, oi-buildup, pcr, iv-spike).
- **Signals_Board_Entry**: A signal surfaced on the unified `/in/signals` board — merges all six scanner types into one ranked feed.
- **Paper_Trade_Event**: A change to an `in:`-prefixed `PaperTrade` row — one of: trade opened (`OPEN`), trade closed to WIN, trade closed to LOSS, trade EXPIRED, or trade CANCELLED.
- **NSE**: National Stock Exchange of India.
- **BSE**: Bombay Stock Exchange of India.
- **IST**: Indian Standard Time (UTC+5:30), the timezone used for all timestamps in notifications.
- **Cooldown**: A per-event-type minimum interval enforced in Redis to prevent duplicate WhatsApp messages for the same underlying event.
- **Phone_Number**: The E.164-formatted WhatsApp recipient number stored per user in `UserSetting.apiKeysEncrypted` under the key `whatsapp`.
- **WHATSAPP_EVOLUTION_API_URL**: Server-side environment variable holding the base URL of the Evolution-Go instance (e.g. `http://localhost:8080`).
- **WHATSAPP_INSTANCE**: Server-side environment variable holding the Evolution-Go session/instance name.
- **WHATSAPP_API_KEY**: Server-side environment variable holding the Evolution-Go API authentication key.
- **Lot_Size**: The standardised NSE contract multiplier for F&O instruments (e.g. NIFTY = 50, BANKNIFTY = 15).

---

## Requirements

### Requirement 1: WhatsApp Channel Integration

**User Story:** As a trader, I want to receive WhatsApp messages from AlphaForge so that I can act on trading signals without having to monitor the dashboard.

#### Acceptance Criteria

1. THE `WhatsApp_Notifier` SHALL dispatch messages by sending an authenticated HTTP POST request to `{WHATSAPP_EVOLUTION_API_URL}/message/sendText/{WHATSAPP_INSTANCE}` with the recipient phone number and message text.
2. WHEN `WHATSAPP_EVOLUTION_API_URL` is not set in the environment, THE `WhatsApp_Notifier` SHALL skip all dispatch attempts and log a warning at the `warn` level, without throwing an error.
3. WHEN `WHATSAPP_INSTANCE` is not set in the environment, THE `WhatsApp_Notifier` SHALL skip all dispatch attempts and log a warning at the `warn` level, without throwing an error.
4. WHEN the Evolution API returns an HTTP status code outside the 2xx range, THE `WhatsApp_Notifier` SHALL log the failure including the status code and response body, and return a failed dispatch outcome without rethrowing.
5. WHEN a network timeout or connection error occurs during dispatch, THE `WhatsApp_Notifier` SHALL abort the request after 8 seconds, log the error, and return a failed dispatch outcome without rethrowing.
6. THE `WhatsApp_Notifier` SHALL include the `WHATSAPP_API_KEY` value in the `apikey` request header on every Evolution API call when `WHATSAPP_API_KEY` is set.
7. THE `WhatsApp_Notifier` SHALL be registered as a new channel (`WHATSAPP`) alongside the existing `IN_APP`, `EMAIL`, and `WEBHOOK` channels in `src/features/alerts/channels.ts`.

---

### Requirement 2: User Phone Number Configuration

**User Story:** As a trader, I want to save my WhatsApp phone number in my profile so that notifications are sent to my personal number.

#### Acceptance Criteria

1. THE Profile page (`/in/profile`) SHALL render a "WhatsApp Notifications" form field that accepts an E.164 phone number (e.g. `+919876543210`).
2. WHEN the user saves a WhatsApp number through the profile form, THE System SHALL encrypt the number using AES-256-GCM and persist it under the key `whatsapp` within `UserSetting.apiKeysEncrypted`.
3. WHEN a WhatsApp notification is triggered for a user, THE `WhatsApp_Notifier` SHALL decrypt and read the phone number from `UserSetting.apiKeysEncrypted` under the key `whatsapp`.
4. IF the user has not configured a WhatsApp phone number, THEN THE `WhatsApp_Notifier` SHALL skip dispatch for that user and log a debug message, without producing an error.
5. THE Profile page SHALL display a masked preview of the stored phone number (e.g. `+91 98765 •••••`) when a number is already saved.
6. THE Profile page SHALL allow the user to delete a saved phone number by clicking a "Remove" action, which clears the `whatsapp` key from `UserSetting.apiKeysEncrypted`.
7. WHEN the user submits a phone number that does not match the E.164 format (`+` followed by 7–15 digits), THE Profile page SHALL display an inline validation error and prevent form submission.

---

### Requirement 3: Per-User WhatsApp Notification Preferences

**User Story:** As a trader, I want to choose which event types trigger WhatsApp messages so that I only receive notifications I care about.

#### Acceptance Criteria

1. THE Profile page SHALL render a "WhatsApp Alerts" preference section that shows five toggles: Daily Picks, AI Signals, Scanner Signals, Signals Board, and Paper Trading.
2. WHEN the user saves WhatsApp preferences, THE System SHALL persist the enabled event types as a JSON array under `UserSetting.dataSourcesJson` at the path `whatsapp.enabledEvents`.
3. WHEN a notification event is triggered, THE `WhatsApp_Notifier` SHALL read the user's `whatsapp.enabledEvents` preference and skip dispatch for any event type that is not included in the array.
4. WHERE a user has never set WhatsApp preferences, THE System SHALL treat all five event types as enabled by default.
5. THE System SHALL persist WhatsApp preferences independently of other data source settings so that changing a data source does not alter notification preferences.

---

### Requirement 4: Daily Picks WhatsApp Notification

**User Story:** As a trader, I want to receive a WhatsApp message when new Daily Picks are frozen for the day so that I can review and act on them immediately at market open.

#### Acceptance Criteria

1. WHEN the `india-daily-picks` worker job freezes new picks for an IST trading day for the first time (`res.persisted === true`), THE System SHALL emit a `DAILY_PICKS_NEW` notification event for each pick bucket that contains at least one newly frozen pick.
2. THE `WhatsApp_Notifier` SHALL format each `DAILY_PICKS_NEW` message to include: bucket name, rank, symbol, exchange (NSE or BSE), action (LONG/SHORT/BUY/SELL), entry price in ₹, stop-loss in ₹, target in ₹, can-move-upto in ₹, can-expect %, confidence score, grade, and the pick's logic string.
3. THE `WhatsApp_Notifier` SHALL prefix all ₹ amounts in Daily Picks messages with the `₹` symbol and format them with Indian number notation (e.g. `₹23,450.00` for NIFTY levels, `₹2,345.50` for stock prices).
4. WHEN a Daily Pick is for an index instrument (INDICES_SCALP or OPENING_BREAKOUT bucket with an index symbol), THE message SHALL include the lot size (e.g. `Lot: 50`) so the trader can calculate notional exposure.
5. THE `WhatsApp_Notifier` SHALL include the IST timestamp of the freeze in the format `DD-Mon-YYYY HH:MM IST` in every Daily Picks message.
6. IF a `DAILY_PICKS_NEW` notification event has already been dispatched for the same `tradeDate` and `bucket`, THEN THE `WhatsApp_Notifier` SHALL suppress the duplicate using a Redis cooldown key `whatsapp:cooldown:daily-picks:{tradeDate}:{bucket}` with a TTL of 23 hours.

---

### Requirement 5: AI Signals WhatsApp Notification

**User Story:** As a trader, I want a WhatsApp message when a high-confidence AI Signal is generated for an F&O instrument so that I can evaluate the setup promptly.

#### Acceptance Criteria

1. WHEN `getIndiaAiSignals()` produces a signal with `action !== "WAIT"` and `confidenceScore >= 60`, THE System SHALL emit an `AI_SIGNAL_NEW` notification event for that signal.
2. THE `WhatsApp_Notifier` SHALL format each `AI_SIGNAL_NEW` message to include: symbol, action, confidence score (0–100), grade (S/A/B/C/D), entry price in ₹, stop-loss in ₹, TP1/TP2/TP3 prices in ₹, risk:reward ratio, win probability %, horizon, and the top 3 rationale bullets.
3. THE `WhatsApp_Notifier` SHALL include the expiry ATM option strike from the signal's `strike` field (e.g. `Strike: 23,400 CE`) when the signal is for an index underlying.
4. WHEN a new AI Signal is generated for a symbol that already had an AI Signal notification dispatched within the last 30 minutes, THE `WhatsApp_Notifier` SHALL suppress the message using a Redis cooldown key `whatsapp:cooldown:ai-signal:{symbol}` with a TTL of 30 minutes.
5. THE `WhatsApp_Notifier` SHALL format AI Signal messages with a header emoji that reflects the action: `🟢` for LONG/BUY, `🔴` for SHORT/SELL.
6. WHERE the AI Signal carries an `mlEnhanced: true` flag, THE message SHALL include an `[ML ✓]` tag to indicate the signal was validated by the ML service.

---

### Requirement 6: Scanner Signal WhatsApp Notification

**User Story:** As a trader, I want a WhatsApp message when the F&O scanner produces a new hit so that I can check it on the scanner page.

#### Acceptance Criteria

1. WHEN `/api/in/scanner` returns one or more new scanner hits that were not present in the previous scan result for the same scanner type, THE System SHALL emit a `SCANNER_HIT_NEW` notification event for each new hit.
2. THE `WhatsApp_Notifier` SHALL format each `SCANNER_HIT_NEW` message to include: scanner type label (e.g. "Range Expansion", "OI Build-up"), symbol, exchange, current price in ₹, day change %, and the hit's key metric (e.g. OI build-up kind, PCR value, IV spike %).
3. WHEN a new scanner hit is detected for a symbol on a given scanner type, THE `WhatsApp_Notifier` SHALL suppress duplicate messages using a Redis cooldown key `whatsapp:cooldown:scanner:{type}:{symbol}` with a TTL of 15 minutes.
4. THE `WhatsApp_Notifier` SHALL format the scanner type label using the human-readable name from the scanner catalog (e.g. `oi-buildup` → "OI Build-up"), never the internal type string.
5. IF more than 5 new hits are detected in a single scanner tick, THEN THE `WhatsApp_Notifier` SHALL send a single summary message listing all symbols rather than one message per hit, to avoid message flooding.

---

### Requirement 7: Signals Board WhatsApp Notification

**User Story:** As a trader, I want a WhatsApp message when a new signal appears on the unified Signals board so that I can track emerging setups.

#### Acceptance Criteria

1. WHEN the unified signals feed (served by `/api/in/signals`) produces a new signal entry with a strength score above the 70th percentile of the current feed, THE System SHALL emit a `SIGNALS_BOARD_NEW` notification event.
2. THE `WhatsApp_Notifier` SHALL format each `SIGNALS_BOARD_NEW` message to include: symbol, exchange, signal source type, action or direction, current price in ₹, day change %, and the signal's key metric value.
3. WHEN a Signals Board notification has been dispatched for the same symbol within the last 20 minutes, THE `WhatsApp_Notifier` SHALL suppress the duplicate using a Redis cooldown key `whatsapp:cooldown:signals-board:{symbol}` with a TTL of 20 minutes.
4. THE `WhatsApp_Notifier` SHALL include the IST time of detection in the format `HH:MM IST` at the bottom of every Signals Board message.

---

### Requirement 8: Paper Trading WhatsApp Notification

**User Story:** As a trader, I want a WhatsApp message for every Paper Trading position event (opened, closed WIN/LOSS, expired) so that I can track the automated engine's activity.

#### Acceptance Criteria

1. WHEN a new `PaperTrade` row with a source prefixed `in:` transitions to status `OPEN`, THE System SHALL emit a `PAPER_TRADE_OPENED` notification event.
2. WHEN an `in:`-prefixed `PaperTrade` row transitions from `OPEN` to `WIN`, THE System SHALL emit a `PAPER_TRADE_WIN` notification event.
3. WHEN an `in:`-prefixed `PaperTrade` row transitions from `OPEN` to `LOSS`, THE System SHALL emit a `PAPER_TRADE_LOSS` notification event.
4. WHEN an `in:`-prefixed `PaperTrade` row transitions from `OPEN` to `EXPIRED`, THE System SHALL emit a `PAPER_TRADE_EXPIRED` notification event.
5. THE `WhatsApp_Notifier` SHALL format `PAPER_TRADE_OPENED` messages to include: symbol, exchange, direction (LONG/SHORT), strategy name derived from the `source` field, entry price in ₹, stop-loss in ₹, target in ₹, risk:reward, and the `openedAt` IST timestamp.
6. THE `WhatsApp_Notifier` SHALL format `PAPER_TRADE_WIN` and `PAPER_TRADE_LOSS` messages to include: symbol, exchange, direction, exit price in ₹, P&L % (prefixed with `+` for WIN, `-` for LOSS), and the duration from open to close (e.g. "Held 1h 23m").
7. THE `WhatsApp_Notifier` SHALL format `PAPER_TRADE_EXPIRED` messages to include: symbol, direction, entry price in ₹, final price in ₹, and P&L % at expiry.
8. THE `WhatsApp_Notifier` SHALL emit a `🟢` emoji for WIN outcomes and a `🔴` emoji for LOSS outcomes in the message header.
9. WHEN more than 3 Paper Trading events occur within a 60-second window for the same symbol, THE `WhatsApp_Notifier` SHALL batch subsequent events for that symbol into a single summary message, using a Redis cooldown key `whatsapp:cooldown:paper-trade:{symbol}` with a TTL of 60 seconds.

---

### Requirement 9: Message Formatting Standards for Indian Market

**User Story:** As a trader operating in the Indian market, I want notification messages formatted with Indian conventions so that the data is immediately readable and actionable.

#### Acceptance Criteria

1. THE `WhatsApp_Notifier` SHALL format all price values for NSE index instruments (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) using integer-with-comma Indian notation (e.g. `₹23,450`, not `₹23,450.00`) since indices trade in whole points.
2. THE `WhatsApp_Notifier` SHALL format all price values for NSE equity instruments using two-decimal Indian notation (e.g. `₹2,345.50`).
3. THE `WhatsApp_Notifier` SHALL include the exchange label (`NSE` or `BSE`) in every notification message.
4. THE `WhatsApp_Notifier` SHALL render all timestamps in IST (UTC+5:30) using the format `DD-Mon-YYYY HH:MM IST` for date-times and `HH:MM IST` for intraday times.
5. THE `WhatsApp_Notifier` SHALL include a footer line in every message with the text `AlphaForge • NSE F&O • {HH:MM IST}` to identify the source.
6. WHERE a signal is for an expiry day (the `optionContract` field is non-null), THE message SHALL include the contract symbol (e.g. `NIFTY25JUL23400CE`) and premium in ₹.

---

### Requirement 10: Notification Delivery Reliability and Error Handling

**User Story:** As a platform operator, I want notification failures to be logged and non-fatal so that a WhatsApp API outage never disrupts the trading engine.

#### Acceptance Criteria

1. IF the Evolution API is unreachable, THEN THE `WhatsApp_Notifier` SHALL log the failure at the `warn` level using the existing worker logger, capture the error in Sentry when `SENTRY_DSN` is set, and continue normal engine operation without throwing.
2. THE `WhatsApp_Notifier` SHALL perform at most 1 retry on a network timeout before recording a failure outcome, waiting 2 seconds between the initial attempt and the retry.
3. WHILE a WhatsApp dispatch is pending, THE System SHALL not block the worker tick that triggered the notification — dispatch SHALL be fire-and-forget from the worker's perspective.
4. THE `WhatsApp_Notifier` SHALL record each dispatch attempt outcome (success or failure, including HTTP status code or error message) in a structured log line at the `debug` level.
5. THE System SHALL provide a `GET /api/in/whatsapp/status` route that returns the Evolution API connectivity status (`reachable: boolean`), the configured instance name, and the last dispatch timestamp, so operators can verify the integration is live.
6. IF `WHATSAPP_API_KEY` is not set but `WHATSAPP_EVOLUTION_API_URL` is set, THEN THE `WhatsApp_Notifier` SHALL still attempt dispatch without an API key header, because some self-hosted Evolution instances run without authentication.

---

### Requirement 11: Settings UI Integration

**User Story:** As a developer, I want the WhatsApp configuration to live in the existing Profile page so that users have a single place to manage all notification channels.

#### Acceptance Criteria

1. THE `ApiKeysForm` component (`src/components/settings/api-keys-form.tsx`) SHALL render a dedicated "WhatsApp" section with a phone number input field and a save/delete button.
2. THE Profile page SHALL render the "WhatsApp Alerts" preference toggles (from Requirement 3) below the phone number field in the same WhatsApp section.
3. WHEN no `WHATSAPP_EVOLUTION_API_URL` is set, THE WhatsApp section SHALL display an informational banner explaining that a self-hosted Evolution-Go instance is required and linking to `https://github.com/evolution-foundation/evolution-go`.
4. THE `AlertsManager` component SHALL list `WHATSAPP` as a selectable channel in the channel checkboxes alongside `IN_APP`, `EMAIL`, and `WEBHOOK`, so users can opt WhatsApp into any existing alert rule.
5. THE WhatsApp section SHALL include a "Send Test Message" button that triggers `POST /api/in/whatsapp/test` and displays a toast notification with the outcome (delivered / failed).

---

### Requirement 12: Environment Configuration

**User Story:** As a platform operator, I want to configure the WhatsApp integration via environment variables so that I can deploy it to different environments without code changes.

#### Acceptance Criteria

1. THE `src/lib/env.ts` server schema SHALL include `WHATSAPP_EVOLUTION_API_URL` as an optional `z.string().url()` field.
2. THE `src/lib/env.ts` server schema SHALL include `WHATSAPP_INSTANCE` as an optional `z.string()` field.
3. THE `src/lib/env.ts` server schema SHALL include `WHATSAPP_API_KEY` as an optional `z.string()` field.
4. THE `.env.example` file SHALL include commented entries for `WHATSAPP_EVOLUTION_API_URL`, `WHATSAPP_INSTANCE`, and `WHATSAPP_API_KEY` with descriptive comments explaining each variable.
5. THE `worker/src/config.ts` SHALL include a `whatsapp` section with `enabled: boolean` derived from whether `WHATSAPP_EVOLUTION_API_URL` and `WHATSAPP_INSTANCE` are both set, so the worker can cheaply gate WhatsApp logic without env reads in the hot path.
