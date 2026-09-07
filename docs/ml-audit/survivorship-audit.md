# Survivorship Bias Audit

**Verification Date:** 2026-09-06  
**Method:** Direct code inspection of universe construction, data fetching, and label generation.

---

## 1. How the Current System Builds Its Historical Universe

### 1.1 The Training Universe

File: `src/training/data_pipeline.py` lines 77-106

```python
TRAINING_UNIVERSE: list[str] = [
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY",
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", ...
    # ~50 symbols total
]
```

**Verdict: CURRENT UNIVERSE — NOT point-in-time.**

This is a hardcoded list of stocks that are F&O-eligible **today** (as of the date the file was written). There is no mechanism to query historical F&O eligibility at each training date.

### 1.2 No Historical Universe Registry

Searched entire codebase for any evidence of historical universe management:

```
grep -rn "eligible\|historical_universe\|universe_at\|pit_universe\|point_in_time" src/ → 0 results
grep -rn "NSE.*eligible\|F&O.*eligible\|lot_size.*history" src/ → 0 results
grep -rn "added_to_fno\|removed_from_fno\|delist" src/ → 0 results
```

**Finding: No historical universe registry exists anywhere in the codebase.**

---

## 2. Survivorship Bias Classification

| Bias Type | Present | Magnitude | Verified |
|---|---|---|---|
| **F&O additions** (recent additions included in full backtest) | ✅ YES | Medium | Using ZOMATO, DLF, TRENT, JIOFIN (recently listed/added) in 5-year backtest includes periods when they weren't F&O-eligible |
| **F&O removals** (removed stocks absent from backtest) | ✅ YES | High | Stocks removed from F&O list (low volume, regulatory, corporate action) are not included |
| **Delisted stocks** | ✅ YES | Low-Medium | Delisted stocks (e.g., Vodafone Idea reduced lot size history, some mid-caps that exited) absent |
| **Symbol changes** | ❓ UNKNOWN | Unknown | No mechanism to handle symbol renames (e.g., HDFC → HDFCBANK after merger) |
| **Mergers** | ❓ UNKNOWN | Low | Merger survivors are included, merged entities may be absent |
| **Corporate actions** (split/bonus) | ✅ PARTIAL | High | OHLCV adjusted by data vendor, but adjustment status not verified |
| **Index membership** | ❌ NOT APPLICABLE | — | System uses F&O eligibility, not index membership |
| **Lot-size changes** | ❌ NOT MODELLED | Medium | SEBI changed lot sizes Nov 2024; historical OI scaled to different lot sizes |
| **Contract changes** | ❌ NOT MODELLED | Medium | Contract specifications change over time |

---

## 3. Specific Examples of Potential Survivorship Bias

### 3.1 Recently Listed / Recently Added to F&O

Symbols in `TRAINING_UNIVERSE` that may have been added to F&O relatively recently:

| Symbol | Approximate F&O Addition | Impact |
|---|---|---|
| ZOMATO | ~2022 (listed July 2021) | 3-year backtest includes full history; pre-F&O period absent |
| JIOFIN | ~2023-2024 (new listing) | Limited backtest history available |
| TRENT | May have been added/removed during the period | Unknown |
| ADANIENT | Periods of very high volatility (Hindenburg Jan 2023) create survivorship-selection |

### 3.2 Corporate Actions Affecting Historical Data

Key corporate actions in the training universe that affect data integrity:

| Event | Stock | Date | Impact on Features |
|---|---|---|---|
| HDFC Bank / HDFC Ltd merger | HDFCBANK | July 2023 | Symbol continued; combined entity has different price history |
| Reliance bonus 1:1 | RELIANCE | September 2017 | Price history before bonus is double current price; momentum features affected if unadjusted |
| NSE lot size changes (SEBI Nov 2024) | All F&O | Nov 2024 | OI data scaled differently before/after; PCR comparisons across this date are invalid |

### 3.3 F&O Ban Periods in Historical Data

Several TRAINING_UNIVERSE stocks have historically entered the F&O ban list (OI > 95% MWPL). During ban periods:
- Only closing trades allowed → OI data shows artificial decline
- PCR becomes unreliable
- IV may spike (uncertainty about ban duration)

The training data includes these ban periods without flagging them, creating distorted OI/PCR features for those dates.

---

## 4. Impact Quantification

The magnitude of survivorship bias depends on what happened to non-surviving stocks vs surviving stocks. Academic research on Indian equities suggests:

- **F&O-eligible stocks outperform non-F&O stocks** by 2-5% annually (selection bias in eligibility criteria: large cap, high volume)
- **Removed stocks tend to have weaker returns** in the period before removal (hence why they fail eligibility criteria)
- **Estimate**: Training a model on today's survivors and testing on historical data inflates apparent IC by approximately 0.01-0.03 additional IC units

For a model targeting IC = 0.03-0.05, this survivorship inflation of 0.01-0.03 could represent 20-100% of the measured signal.

---

## 5. What Would Be Required to Fix This

### 5.1 NSE F&O Historical Eligibility Data

NSE publishes the F&O eligible security list via circulars. A historical registry would require:
1. Crawling NSE circulars from 2018-2026 (~8 years)
2. Building a database of (symbol, added_date, removed_date, lot_size_at_date)
3. Replacing `TRAINING_UNIVERSE` with a query: `universe_at_date(date)` → list of eligible symbols

### 5.2 Corporate Action Adjustment Verification

The data client (`AlphaForgeAPIClient`) does not document whether Angel One / Upstox APIs return adjusted or unadjusted OHLCV. This must be verified:
- If adjusted: confirm the adjustment method (back-adjusted vs forward-adjusted)
- If unadjusted: implement price adjustment for splits, bonuses, rights issues

### 5.3 Symbol Continuity Handling

Post-merger symbols (HDFCBANK post-HDFC merger) need special handling: the pre-merger and post-merger entities have different business profiles despite sharing a symbol.

---

## 6. Verdict

**The AlphaForge training system uses the current-day F&O universe for all historical training.**

This means:
- ALL model training is subject to survivorship bias of unknown magnitude (estimated 0.01-0.03 IC inflation)
- ANY performance claim from historical backtest must be discounted by this survivorship premium
- The system CANNOT be certified as using point-in-time historical universe data

**Classification: MISSING — point-in-time universe registry does not exist.**

This is a **required** fix before any performance claim can be considered statistically valid.
