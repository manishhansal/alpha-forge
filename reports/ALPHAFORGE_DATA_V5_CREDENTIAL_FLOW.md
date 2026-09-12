# ALPHAFORGE — V5 CREDENTIAL FLOW (§5)

The V5 root-cause artifact. Traces broker credentials from the frontend store to
the runtime provider client. No secret values shown — only status.

## The disconnect V4 missed
V4 checked `process.env` and reported Angel/Upstox `configured:false`. But the
operator configured credentials via the **frontend Data Sources / Profile → API
Keys UI**, which stores them **encrypted in the database**, not in `.env`. So:

```
frontend credential state  ≠  runtime provider credential state
```

## Where credentials actually live (DB-VERIFIED)
`UserSetting.apiKeysEncrypted` (per-user, AES-256-GCM via `@/lib/crypto`):
- `angel` → `{ apiKey, clientCode, pin, totpSecret, readOnly, updatedAt }` (complete)
- `upstox` → `{ apiKey (= Analytics Token, 337 chars), readOnly, updatedAt }`

Decryption verified worker-style (no session): Angel apiKey/clientCode/pin/totp
all decrypt; Upstox analytics token decrypts (337 chars). `ENCRYPTION_KEY` present.

## Per-provider flow

### Angel One
```
Profile → API Keys UI
  → saveApiKey(userId, {angel...})           encrypt() → UserSetting.apiKeysEncrypted.angel
  → readAngelCredentials(userId)             decrypt() [takes userId — NO session needed]
  → getAngelConfigForRequest()               calls auth() → NULL in worker  ← THE BREAK
  → angel.resolveConfig()                    env → [V5 worker override] → session
  → login(cfg)                               real SmartAPI TOTP→JWT
  → getCandleData                            real historical
```

### Upstox
```
Profile → API Keys UI (Analytics Token)
  → UserSetting.apiKeysEncrypted.upstox.apiKey
  → readUpstoxCredentials(userId)            decrypt() [takes userId — NO session]
  → getUpstoxTokenForRequest()               calls auth() → NULL in worker  ← THE BREAK
  → resolveReadToken()                       env → [V5 worker override] → session
  → /v3/historical-candle                    real historical (incl indices)
```

## The V5 fix (`src/lib/market-data/worker-credentials.ts`)
A **process-scoped credential override** the worker/CLI populates at startup via
`loadWorkerCredentialsFromDb({userId?})`, which resolves the owning user
directly (single-operator: auto; multi-user: explicit userId) and calls
`readAngelCredentials`/`readUpstoxCredentials(userId)` — no session. The Angel
`resolveConfig()` and Upstox `resolveReadToken()` now consult this override
BEFORE the session path. Result: the worker uses the frontend-configured broker
credentials. Verified: worker loaded both, Angel authenticated, real data fetched.

## Status table (no secrets)
| Provider | stored | decryptable | runtime-available (worker) | authenticated (real call) |
|---|---|---|---|---|
| angel_one | yes (env: no, db: yes) | yes | yes (via override) | **yes** (SmartAPI login) |
| upstox | yes (env: no, db: yes) | yes | yes (via override) | **yes** (V3 200) |
| scrapling | DATA_SERVICE_URL set | n/a | yes | quote-only |
| yahoo | none needed | n/a | yes | not exercised |

## Worker restart (§72)
The override is loaded at process start (or first CLI invocation). After the
operator changes credentials in the UI, the worker must reload — either restart
or a periodic `loadWorkerCredentialsFromDb()` refresh (the loader is idempotent
and cheap). Documented; no `.env` editing required.
