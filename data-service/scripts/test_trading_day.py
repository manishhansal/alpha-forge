#!/usr/bin/env python3
"""
Test OpenChart with a date range ending on a known trading day (Fri Sep 11, 2026).
Also tests with a longer historical range to get older data (avoid weekend issue).
"""
import sys, time
from datetime import datetime, date, timezone

sys.path.insert(0, "src")
from curl_cffi import requests as cffi_requests

session = cffi_requests.Session(impersonate="chrome110")
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "Origin": "https://charting.nseindia.com",
    "Referer": "https://charting.nseindia.com/",
})
r = session.get("https://www.nseindia.com", timeout=12)
print(f"Homepage: {r.status_code}")
time.sleep(2)
r2 = session.get("https://charting.nseindia.com", timeout=12)
print(f"Charting home: {r2.status_code}")
time.sleep(1.5)

def hist(token, symbol, sym_type, from_dt, to_dt, interval="1d", tf_int=1, ct="D"):
    payload = {
        "token": str(token),
        "fromDate": int(from_dt.timestamp()),
        "toDate":   int(to_dt.timestamp()),
        "symbol": symbol,
        "symbolType": sym_type,
        "chartType": ct,
        "timeInterval": tf_int,
    }
    r = session.post(
        "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
        json=payload, timeout=12,
    )
    data = r.json() if r.status_code == 200 else {}
    records = data.get("data", [])
    return r.status_code, records

# Known trading days
from_d = datetime(2026, 8, 1, tzinfo=timezone.utc)   # Aug 1
to_d   = datetime(2026, 9, 11, tzinfo=timezone.utc)  # Last trading Fri

print("\n--- NIFTY 50 daily Aug1-Sep11 ---")
sc, data = hist(26000, "NIFTY 50", "Index", from_d, to_d)
print(f"  status={sc} records={len(data)}")
if data: print(f"  First: {data[0]}  Last: {data[-1]}")
time.sleep(2)

print("\n--- RELIANCE daily Aug1-Sep11 ---")
sc, data = hist(2885, "RELIANCE-EQ", "Equity", from_d, to_d)
print(f"  status={sc} records={len(data)}")
if data: print(f"  First: {data[0]}  Last: {data[-1]}")
time.sleep(2)

# Try a longer range
from_d2 = datetime(2025, 1, 1, tzinfo=timezone.utc)
print("\n--- NIFTY 50 daily Jan2025-Sep2026 (long range) ---")
sc, data = hist(26000, "NIFTY 50", "Index", from_d2, to_d)
print(f"  status={sc} records={len(data)}")
if data: print(f"  First: {data[0]}  Last: {data[-1]}")
time.sleep(2)

# 5m intraday on Sep 11 (last trading day)
from_intra = datetime(2026, 9, 11, 3, 45, 0, tzinfo=timezone.utc)  # 09:15 IST
to_intra   = datetime(2026, 9, 11, 10, 0, 0, tzinfo=timezone.utc)  # 15:30 IST
print("\n--- NIFTY 50 5m Sep11 intraday ---")
sc, data = hist(26000, "NIFTY 50", "Index", from_intra, to_intra, "5m", 5, "I")
print(f"  status={sc} records={len(data)}")
if data: print(f"  First: {data[0]}  Last: {data[-1]}")

print("\n=== done ===")
