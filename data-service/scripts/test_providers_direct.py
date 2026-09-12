#!/usr/bin/env python3
"""Direct provider connectivity test — run on the host machine."""
import sys
import traceback
sys.path.insert(0, "src")
from datetime import date, datetime, timedelta

print("=== Jugaad direct test ===")
try:
    from jugaad_data.nse import stock_df
    df = stock_df(
        symbol="RELIANCE",
        from_date=date(2026, 9, 8),
        to_date=date(2026, 9, 11),
        series="EQ",
    )
    if df is not None and len(df) > 0:
        print(f"jugaad RELIANCE 4-day: {len(df)} rows")
        cols = [c for c in ["DATE", "OPEN", "HIGH", "LOW", "CLOSE", "VOLUME"] if c in df.columns]
        print(df[cols].to_string())
    else:
        print("empty result")
except Exception as e:
    print(f"jugaad error: {e}")
    traceback.print_exc()

print("\n=== OpenChart direct test ===")
try:
    from openchart import NSEData
    nse = NSEData()
    end = datetime.now()
    start = end - timedelta(days=10)

    # Try index first (confirmed in search results)
    df2 = nse.historical("NIFTY 50", "IDX", start, end, "1d")
    if df2 is not None and len(df2) > 0:
        print(f"NIFTY 50 1d: {len(df2)} rows")
        print(df2.head(3).to_string())
    else:
        print("NIFTY 50: empty — checking error details")
        import inspect
        print("historical_url:", nse.historical_url)
        # Try FO directly
        df3 = nse.historical("NIFTY26OCTFUT", "FO", start, end, "1d")
        print(f"NIFTY FUT: {df3}")
except Exception as e:
    print(f"openchart error: {e}")
    traceback.print_exc()

print("\n=== V8 adapter tests ===")
try:
    from src.providers.jugaad.adapter import JugaadAdapter
    import asyncio

    async def test_jugaad():
        adapter = JugaadAdapter()
        result = await adapter.get_equity_eod(
            symbol="RELIANCE",
            from_date=date(2026, 9, 8),
            to_date=date(2026, 9, 11),
        )
        print(f"JugaadAdapter status: {result.status}")
        print(f"rows_fetched={result.rows_fetched} rows_valid={result.rows_valid}")
        if result.error:
            print(f"error: {result.error}")
        if result.candles:
            c = result.candles[0]
            print(f"First candle: {c.sessionDate} O={c.open} H={c.high} L={c.low} C={c.close} V={c.volume} OI={c.oi}")

    asyncio.run(test_jugaad())
except Exception as e:
    print(f"JugaadAdapter error: {e}")
    traceback.print_exc()
