#!/usr/bin/env python3
"""Smoke test of OpenChart adapter with curl_cffi session injection."""
import asyncio, sys, time
sys.path.insert(0, "src")
from datetime import date, timedelta
from src.providers.openchart.adapter import OpenChartAdapter


async def main():
    adapter = OpenChartAdapter()
    print(f"openchart_available: {adapter._openchart_available}")
    print(f"cffi_available:      {adapter._cffi_available}")

    # Warm up (seeds cookies, injects curl_cffi)
    adapter._ensure_session()
    cffi_sess = adapter._cffi_session
    if cffi_sess is not None:
        print(f"curl_cffi session: {list(cffi_sess.cookies.keys())}")

    # Test with range ending on last trading day
    end_d   = date(2026, 9, 11)
    start_d = end_d - timedelta(days=30)

    print(f"\nNIFTY 50 daily {start_d} -> {end_d}...")
    r1 = await adapter.get_historical(
        symbol="NIFTY 50",
        segment="IDX",
        interval_str="1d",
        from_date=start_d,
        to_date=end_d,
    )
    print(f"  status={r1.status}  fetched={r1.rows_fetched}  valid={r1.rows_valid}")
    if r1.candles:
        c = r1.candles[0]
        print(f"  First: {c.sessionDate} O={c.open} H={c.high} L={c.low} C={c.close}")
    if r1.error:
        print(f"  error: {r1.error}")

    time.sleep(2)

    print(f"\nRELIANCE daily {start_d} -> {end_d}...")
    r2 = await adapter.get_historical(
        symbol="RELIANCE",
        segment="EQ",
        interval_str="1d",
        from_date=start_d,
        to_date=end_d,
    )
    print(f"  status={r2.status}  fetched={r2.rows_fetched}  valid={r2.rows_valid}")
    if r2.candles:
        c2 = r2.candles[0]
        print(f"  First: {c2.sessionDate} O={c2.open} H={c2.high} L={c2.low} C={c2.close}")
    if r2.error:
        print(f"  error: {r2.error}")

    time.sleep(2)

    print(f"\nRELIANCE 5m {end_d} (intraday)...")
    r3 = await adapter.get_historical(
        symbol="RELIANCE",
        segment="EQ",
        interval_str="5m",
        from_date=end_d,
        to_date=end_d,
    )
    print(f"  status={r3.status}  fetched={r3.rows_fetched}  valid={r3.rows_valid}")
    if r3.candles:
        print(f"  First: {r3.candles[0].sessionDate} C={r3.candles[0].close}")
    if r3.error:
        print(f"  error: {r3.error}")


asyncio.run(main())
