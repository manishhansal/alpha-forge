#!/usr/bin/env python3
"""
Verify that curl_cffi bypasses NSE's Akamai WAF.
Tests homepage session seeding, charting endpoint, and option chain API.
"""
import time
from curl_cffi import requests as cffi_requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/119.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
    "Authority": "www.nseindia.com",
}

session = cffi_requests.Session(impersonate="chrome110")
session.headers.update(HEADERS)

print("=== NSE WAF bypass test (curl_cffi) ===\n")

# 1. Homepage — seeds nsit / nseappid / ak_bmsc cookies
print("Step 1: Seeding WAF session cookies from NSE homepage...")
r = session.get("https://www.nseindia.com", timeout=15)
print(f"  Status: {r.status_code}")
print(f"  Cookies set: {list(session.cookies.keys())}")
assert r.status_code == 200, f"Homepage blocked: {r.status_code}"
time.sleep(2)

# 2. OpenChart v1 charting API (the endpoint openchart 0.2.0 uses)
print("\nStep 2: OpenChart charting API (historical NIFTY 50 daily)...")
# openchart uses POST to /v1/charts/symbolHistoricalData
chart_url = "https://charting.nseindia.com/v1/charts/symbolHistoricalData"
import json
from datetime import datetime, timedelta
end = datetime.now()
start = end - timedelta(days=30)
payload = {
    "cinfo": json.dumps({
        "name": "NIFTY 50",
        "cf": "",
        "objSubType": "C",
        "theme": ""
    }),
    "exch": "N",
    "instrType": "C",
    "symbol": "26000",
    "startDate": start.strftime("%d-%b-%Y"),
    "endDate": end.strftime("%d-%b-%Y"),
    "dataType": "DAILY",
}
session.headers.update({"Referer": "https://charting.nseindia.com/"})
r2 = session.post(chart_url, json=payload, timeout=15)
print(f"  Status: {r2.status_code}")
if r2.status_code == 200:
    try:
        data = r2.json()
        candles = data.get("grapthData", data.get("data", data.get("candles", [])))
        print(f"  Candles returned: {len(candles)}")
        if candles:
            print(f"  First candle: {candles[0]}")
    except Exception as e:
        print(f"  Response (first 300 chars): {r2.text[:300]}")
else:
    print(f"  Response (first 300 chars): {r2.text[:300]}")
time.sleep(2)

# 3. NSE option chain
print("\nStep 3: NSE option chain API (NIFTY)...")
session.headers.update({"Referer": "https://www.nseindia.com/"})
r3 = session.get(
    "https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY",
    timeout=15,
)
print(f"  Status: {r3.status_code}")
if r3.status_code == 200:
    d = r3.json()
    records = d.get("records", {}).get("data", [])
    print(f"  Option chain records: {len(records)}")
else:
    print(f"  Response: {r3.text[:200]}")
time.sleep(2)

# 4. NSE equity history (RELIANCE)
print("\nStep 4: NSE equity historical data (RELIANCE)...")
session.headers.update({"Referer": "https://www.nseindia.com/"})
r4 = session.get(
    "https://www.nseindia.com/api/historical/securityArchives"
    "?from=01-09-2026&to=12-09-2026&symbol=RELIANCE&dataType=priceVolumeDeliverable&series=EQ",
    timeout=15,
)
print(f"  Status: {r4.status_code}")
if r4.status_code == 200:
    d = r4.json()
    rows = d.get("data", [])
    print(f"  History rows: {len(rows)}")
    if rows:
        print(f"  Sample: date={rows[0].get('CH_TIMESTAMP')} close={rows[0].get('CH_CLOSING_PRICE')}")
else:
    print(f"  Response: {r4.text[:200]}")

print("\n=== curl_cffi WAF bypass test complete ===")
