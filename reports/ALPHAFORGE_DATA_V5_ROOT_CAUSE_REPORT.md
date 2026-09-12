# ALPHAFORGE — V5 ROOT CAUSE REPORT

## R-V5-01 — Worker could not use frontend-configured broker credentials (THE root cause)
- **Severity:** Critical — the reason intraday was 0 across V2–V4.
- **Symptom:** V4 reported Angel/Upstox `configured:false`; intraday = 0.
- **Evidence (DB-VERIFIED):** credentials present + decryptable in
  `UserSetting.apiKeysEncrypted` (angel: apiKey/clientCode/pin/totpSecret; upstox:
  analyticsToken 337ch). `.env` empty.
- **Root cause:** provider credential resolvers (`getAngelConfigForRequest`,
  `getUpstoxTokenForRequest`) call `auth()`, which returns null without a session
  cookie — true in the worker/backfill/CLI. So the worker fell back to Yahoo and
  never used the stored broker credentials.
- **Fix:** `worker-credentials.ts` process-scoped override +
  `loadWorkerCredentialsFromDb({userId?})` (resolves by userId, no session);
  Angel `resolveConfig()` and Upstox `resolveReadToken()` consult it before the
  session path.
- **Status:** FIXED + LIVE-RUNTIME-VERIFIED (Angel authenticated; real data persisted).

## R-V5-02 — Upstox on V2 historical (no 5m/15m/1h, no indices)
- **Symptom:** Upstox skipped for 5m/15m/1h; indices unavailable.
- **Root cause:** impl used `/v2/historical-candle` (only 1minute/30minute/day).
- **Fix:** added `intervalToUpstoxV3` + `getHistoricalCandlesV3` (`/v3/historical-candle/{key}/{unit}/{value}/…`) — supports minutes/1,3,5,15,30 + hours/days AND indices.
- **Status:** FIXED + LIVE-RUNTIME-VERIFIED (NIFTY/BANKNIFTY 5m/15m/30m/1h persisted).

## R-V5-03 — Upstox candles dropped by validator (newest-first ordering)
- **Symptom:** V3 index fetch persisted only 1 candle.
- **Root cause:** Upstox returns candles newest-first; the validator rejects
  non-ascending timestamps → dropped all but the first.
- **Fix:** sort ascending before validation in `getHistoricalCandlesV3`.
- **Status:** FIXED + DB-VERIFIED (960 index candles).

## R-V5-04 — Angel getCandleData returns empty for index tokens
- **Symptom:** NIFTY/BANKNIFTY historical via Angel = 0 (even 1d).
- **Root cause:** provider behaviour — Angel `getCandleData` does not serve the
  index tokens via this path (token resolution itself is correct: 26000/26009).
- **Fix:** capability-aware routing sends indices to Upstox V3 first. Not a bug in
  our call; documented and worked around with a real alternative provider.
- **Status:** WORKED AROUND (indices via Upstox) — not fabricated.

## R-V5-05 — Option chain: OI real, IV/bid/ask unavailable via Angel synth
- **Root cause:** Angel's chain is synthesised from scrip master + quote (no
  per-strike greeks). Upstox `/v2/option/chain` needs an explicit `expiry_date`
  (returned 400 without it).
- **Fix:** persist real OI to `OptionChainStrike`; IV/bid/ask NULL with
  `*Unavailable` flags. Greeks endpoint is a follow-up.
- **Status:** PARTIAL (OI real, greeks pending).

## Carried / not fully resolved (honest)
- Daily normalization (D-V4-01..04) still unapplied → daily gap recovery UNRESOLVED.
- 1m/3m intraday and full F&O universe + long history: backfill run-parameters, not yet run.
- Realtime WS candle builder: still dormant (historical path was the priority).
- Data gate: wired into india-scalper; other producers pending operator rollout.
