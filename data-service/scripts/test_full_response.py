#!/usr/bin/env python3
"""Inspect full API responses to understand why data=[] despite status=True."""
import sys, time, json
from datetime import datetime, timezone

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

# Seed
r0 = session.get("https://www.nseindia.com", timeout=12)
print(f"NSE home: {r0.status_code}  cookies: {dict(session.cookies)}")
time.sleep(2)
r0b = session.get("https://charting.nseindia.com", timeout=12)
print(f"Charting home: {r0b.status_code}  new_cookies: {list(session.cookies.keys())}")
time.sleep(2)

# Historical request — print EVERYTHING
payload = {
    "token": "26000",
    "fromDate": int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp()),
    "toDate":   int(datetime(2026, 9, 11, tzinfo=timezone.utc).timestamp()),
    "symbol": "NIFTY 50",
    "symbolType": "Index",
    "chartType": "D",
    "timeInterval": 1,
}
r = session.post(
    "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
    json=payload, timeout=12,
)
print(f"\nHistorical POST:")
print(f"  Status: {r.status_code}")
print(f"  Headers: {dict(r.headers)}")
print(f"  Body (full): {r.text}")
time.sleep(2)

# Also try the search to see what's really happening
payload2 = {"symbol": "RELIANCE", "segment": "EQ"}
r2 = session.post(
    "https://charting.nseindia.com/v1/exchanges/symbolsDynamic",
    json=payload2, timeout=12,
)
print(f"\nSearch POST (RELIANCE EQ):")
print(f"  Status: {r2.status_code}")
try:
    d = r2.json()
    print(f"  status={d.get('status')} data_count={len(d.get('data',[]))}")
    for row in d.get("data", [])[:5]:
        print(f"    {row}")
except Exception as e:
    print(f"  parse error: {e}  text: {r2.text[:300]}")
