# ALPHAFORGE — V5 INSTRUMENT MASTER (§9/§14/§21/§22/§23)

Per-provider instrument-key resolution — the layer that lets a symbol reach the
right provider API. Verified against real calls.

## Angel One (symboltoken)
- Equities: resolved from the cached NSE cash ScripMaster (`resolveAngelToken` +
  `buildEqTokenMap`). Verified: RELIANCE/HDFCBANK/ICICIBANK/INFY/TCS/SBIN all
  resolved → real candles.
- Indices: hardcoded `INDEX_TOKENS` (NIFTY=26000, BANKNIFTY=26009, FINNIFTY=26037,
  MIDCPNIFTY=26074, NSE). Resolution VERIFIED, but Angel `getCandleData` returns
  **empty** for index tokens (provider behaviour) — so indices route to Upstox.
- Options: NFO ScripMaster → per-strike tokens (used by the chain synthesiser;
  real OI verified).

## Upstox (instrument_key)
- Equities: ISIN-based key required (`NSE_EQ|INE002A01018`); symbol-based keys
  are rejected (HTTP 400). `resolveUpstoxInstrumentKey` resolves the ISIN from
  the instrument master. Verified: RELIANCE V3 5m = 225.
- Indices: `INDEX_KEYS` (NIFTY→`NSE_INDEX|Nifty 50`, etc.). **Verified working
  via V3** (NIFTY 5m = 225) — this is what unlocked index intraday.
- F&O: `NSE_FO|…` form.

## Yahoo
- `RELIANCE.NS`, `^NSEI` etc. Equity/index only; never for option fields.

## Provider-specific mapping (§21) — verified examples
```
RELIANCE   Angel: NSE cash token   Upstox: NSE_EQ|INE002A01018   Yahoo: RELIANCE.NS
NIFTY      Angel: 26000/NSE(empty) Upstox: NSE_INDEX|Nifty 50    Yahoo: ^NSEI
```

## Instrument-master resilience (§22)
Angel cash + Upstox ISIN masters are independent; a symbol unresolvable on one
routes to the other via the capability-aware selector. No fabricated tokens —
an unresolvable symbol yields empty + failover, never a guessed token.

## Not done this pass (honest)
- A durable, versioned instrument-master snapshot table (`refreshAngel/Upstox…`
  with checksum/recordCount) was NOT added — resolution uses the providers'
  cached in-memory masters. Adding a versioned durable master is a follow-up.
