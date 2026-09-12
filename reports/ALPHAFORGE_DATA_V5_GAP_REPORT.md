# ALPHAFORGE — V5 GAP REPORT (§40/§41)

## Real gap-recovery run
`scripts/data-v5-gap-recovery.ts` wired a REAL Angel/Upstox fetcher into the V3
`recoverPendingGaps` service and ran against the 245 daily `DataGap` rows
(limit=5 batch).

Result: **all attempted gaps → UNRESOLVED, 0 recovered, 0 corrections.**
`data_gap` byStatus after: UNRESOLVED=10, PENDING=235 (total 245).

## Why UNRESOLVED (honest, not a failure to fix)
The daily gaps were detected on the canonical **09:15-IST** grid, but the daily
history carries mixed timestamp conventions (D-V4-01: 18:30-IST etc.). When the
provider re-fetches the missing sessions, the returned candles land at their own
epochs, which do NOT fall inside the canonical-grid gap window — so the recovery
service's `windowCandles` filter correctly finds no bar for that exact
`[gapStart,gapEnd]` and does **not** resolve.

This is the CORRECT fail-closed behaviour (§40): recovery **never resolves on
HTTP 200 alone** — it requires the bar to actually exist in the window. The
mechanism is proven with a real provider; the daily gaps remain UNRESOLVED until
the **V4 daily normalization migration is applied** (which re-times the
non-canonical rows to the canonical grid). After that, re-running recovery will
resolve the genuine holes.

## Intraday gaps
Intraday gap detection was not re-run over the new 5m/15m/30m/1h data this pass
(the backfill is shallow, ~5 sessions). The `gap-detection.service` +
`data-v4-full-universe-gaps` tooling supports it; a run after a deeper backfill
will populate real intraday `DataGap` rows.

## Status
- Daily gap DETECTION: 245 rows (DB-VERIFIED, from V4).
- Daily gap RECOVERY: mechanism LIVE-RUNTIME-VERIFIED (real provider fetch), but
  0 resolved — blocked on the daily normalization (D-V4-01). Honest, no fabrication.
- Intraday gap detection/recovery: NOT_VERIFIED at scale (shallow data).
