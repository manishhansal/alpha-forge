# AlphaForge ML System Card

**Service:** AlphaForge ML service (`ml-service/`)
**Branch:** `refactor/improve-ml-service` · **Commit:** `abbc403`
**Status:** ENGINEERING_READY / PRODUCTION_READY_WITH_LIMITATIONS · **Live trading:** DISABLED
**Last certified:** Phase 3T, 2026-09-06

---

## Purpose

A deterministic, fail-closed, evidence-first ML/quant service for **research and paper trading** on Indian markets. It generates cross-sectional alpha candidates, evaluates them through a meta-model + calibration + expected-value chain, simulates execution and portfolio risk, and records immutable evidence. It is a decision-support and research platform — **not** a live trading system.

## Supported markets

Indian equities (NSE/BSE) and F&O (index and single-stock futures/options). No US-market assumptions govern Indian-market behavior.

## Supported instruments

Cash equity (delivery/intraday), index/stock futures, index/stock options (CE/PE), with PIT lot sizes, tick sizes, expiry, and short constraints.

## Data sources

Canonical hierarchy behind the data-service boundary: Data Service / Scrapling → Angel One SmartAPI → Upstox → Yahoo Finance. Point-in-time snapshots with deterministic identity fingerprints; stale/conflict/future-timestamp detection; no uncontrolled NSE scraping in the production TypeScript layer.

## Feature families

Technical, momentum, volume, volatility, relative strength, market structure, regime, derivatives (OI, PCR, IV, GEX, Greeks), FVG/order-blocks/liquidity/VWAP. Every research feature is documented with provenance, availability timestamp, minimum history, missing-data behavior, and PIT correctness.

## Model families

Cross-sectional rankers (classical, e.g. gradient-boosted), meta-models over primary predictions, calibrators (Platt/isotonic), and experimental deep-learning / RL components. Deep learning and RL are **experimental** and are not claimed to add incremental value.

## Labels

Versioned, point-in-time labels (fixed-return, excess-return, triple-barrier, meta-label, risk-outcome). Meta-model training requires OOS primary predictions.

## Validation methodology

Chronological / walk-forward / purged / embargo / nested validation with a **sealed, untouched final OOS**. Baseline-first, ablation, placebo, negative controls, multiple-testing correction (Bonferroni/Holm/BH, Deflated Sharpe, PBO, Reality Check), and deterministic reproduction.

## Execution assumptions

Next-bar execution by default (no same-bar/perfect fills), applied slippage, gap-through on stops, partial fills under liquidity limits, circuit/price-band checks, F&O ban and expiry handling. Signal price is never the fill price.

## Costs

Point-in-time versioned Indian cost schedules: brokerage, STT, exchange charges, GST, SEBI turnover fee, stamp duty — differentiated by delivery/intraday/F&O and buy/sell.

## Limitations

- Synthetic and historical evidence only; **no real profitable alpha is established**.
- Deep-learning and RL runtime unexercised in the certification environment (torch absent); some tests skipped (sklearn/talib).
- Statistical operating points are provisional (calibrated on synthetic data).
- No real paper sessions accumulated; F&O margin is approximated.

## Known failure modes

Missing/invalid/future data, missing/revoked model, missing/stale calibration, risk-engine unavailability, constraint breach, missing simulator — all **fail closed** to an explicit non-executable decision state. No missing input ever produces an executable BUY/SELL.

## Evidence state

`INSUFFICIENT_EVIDENCE` — operational machinery is green on synthetic/historical data; statistical and economic validity of any specific alpha is unverified and not claimed.

## Paper-trading status

Paper/shadow operations are engineered and tested (immutable sessions, reconciliation, replay, reproduction), but **no real paper sessions have accumulated**. Paper evidence is synthetic to date.

## Live trading

**DISABLED and not supported by the ML service.** There are zero live-order primitives in `ml-service/src`. Live-capable broker code exists only in the TypeScript layer, is gated behind `LIVE_TRADING_ENABLED`, and is outside this service's boundary. Enabling live trading is out of scope for this certification.

## Disclaimers

This system does **not** guarantee returns and does **not** guarantee prediction accuracy. It is a research and paper-trading platform. Any use toward real capital requires separate, explicitly-authorized validation, risk review, and human approval beyond this certification.
