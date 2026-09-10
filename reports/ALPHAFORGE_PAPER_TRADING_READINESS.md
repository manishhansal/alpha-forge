# ALPHAFORGE PAPER-TRADING READINESS

**Date:** 2026-09-09.

> ## Verdict: **READY FOR PAPER — with the persistence wiring as the next step**

Paper trading (no capital at risk) is the correct and safe operating mode. The live
scalper → paper-trade → resolve loop already runs and is look-ahead-safe. What paper
mode still needs to become a genuine learning loop:

## Ready today

- ✅ Live signal generation + paper-trade open/resolve (`india-scalper` worker →
  `openIndiaPaperTrade` → `resolveIndiaOpenTrades`).
- ✅ Look-ahead-safe outcome resolution (both-touched → stop/LOSS).
- ✅ Provider failover + staleness protection + no-NSE.
- ✅ Duplicate-open guard (DUP-001 cross-timeframe).
- ✅ Fail-closed behaviour: missing/critical data → NO_TRADE; untrained model →
  ABSTAIN (enforced by the new model-state gate).

## Required before paper data becomes usable for validation

| Step | Status |
|---|---|
| Durable prediction snapshot per signal (immutable) | 🟡 adapter + tables added (`PrismaSignalRecordStore`); **wire into `openIndiaPaperTrade`** |
| Durable resolution record per outcome (idempotent) | 🟡 added; **wire into `resolveIndiaOpenTrades`** |
| Persist grade/quality/probability/regime/MFE/MAE/returnR/modelVersion | ❌ blocked until the snapshot is wired |
| Live paper monitoring dashboard (Phase 35) | ❌ remaining |

## The paper-trading discipline (per the prompt)

Run in PAPER, do not auto-enable live, collect a sufficient sample with the full
prediction snapshot persisted, then continuously compare predictions to reality
(calibration, quality/grade monotonicity). Only when the 18 production gates pass on
that **real** sample may promotion beyond PAPER be considered.

## Verdict

**PAPER-ready.** The immediate next action is to wire the new durable persistence into
the open/resolve path so that every paper trade preserves its immutable prediction
snapshot — the prerequisite for all real validation. **Do not enable live trading.**
