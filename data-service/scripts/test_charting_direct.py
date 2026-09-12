#!/usr/bin/env python3
"""Direct test of NSE charting API with different date ranges to isolate weekend issue."""
import sys, time, json
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
session.get("https://www.nseindia.com", timeout=12)
time.sleep(1.5)
session.get("https://charting.nseindia.com", timeout=12)
time.sleep(1.5)
print(f"cookies: {list(session.cookies.keys())}")

url = "https://charting.nseindia.com/v1/charts/symbolHistoricalData"

# Test with older date range — 2023 data (should definitely exist)
ranges = [
    ("2023 Aug-Sep",     1691625600, 1694217600),    # Aug 10 – Sep 9, 2023
    ("2024 Jan-Mar",     1704067200, 1711929600),    # Jan 1 – Apr 1, 2024
    ("2026 Aug",         1753920000, 1756598400),    # Aug 1 – Aug 29, 2026
    ("2026 Sep1-11",     1756598400, 1757548800),    # Sep 1-11, 2026
]
for label, from_ts, to_ts in ranges:
    payload = {
        "token": "26000",
        "fromDate": from_ts,
        "toDate": to_ts,
        "symbol": "NIFTY 50",
        "symbolType": "Index",
        "chartType": "D",
        "timeInterval": 1,
    }
    r = session.post(url, json=payload, timeout=12)
    data = r.json() if r.status_code == 200 else {}
    records = len(data.get("data", []))
    print(f"{label}: status={r.status_code} records={records}")
    if records > 0:
        print(f"  FIRST: {data['data'][0]}")
        print(f"  LAST:  {data['data'][-1]}")
    time.sleep(1.5)

# Also check if there is a nsit cookie or session token missing
print(f"\nFinal cookie state: {dict(session.cookies)}")
