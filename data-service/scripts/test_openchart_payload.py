#!/usr/bin/env python3
"""
Dig into OpenChart payload format — find correct field names and date format.
"""
import sys, time, json
from datetime import datetime, timedelta

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
print(f"Homepage: {r.status_code}  cookies: {list(session.cookies.keys())}")
time.sleep(2)

# ── Test 1: search with query field instead of symbol ──────────────────────
print("\n--- Search with 'query' field ---")
for field in ["symbol", "query", "q", "searchText", "text"]:
    payload = {field: "RELIANCE", "segment": "EQ"}
    r = session.post(
        "https://charting.nseindia.com/v1/exchanges/symbolsDynamic",
        json=payload, timeout=10,
    )
    data = r.json() if r.status_code == 200 else {}
    results = data.get("data", [])
    first_sym = results[0].get("symbol", "?") if results else "none"
    print(f"  field='{field}': status={r.status_code} records={len(results)} first={first_sym}")
    time.sleep(0.5)

# ── Test 2: historical with string dates instead of epoch ──────────────────
print("\n--- Historical with string dates ---")
end = datetime.now()
start = end - timedelta(days=30)
# Try DD-Mon-YYYY format (NSE standard)
for date_fmt, from_d, to_d in [
    ("epoch_int",  int(start.timestamp()), int(end.timestamp())),
    ("epoch_ms",   int(start.timestamp()*1000), int(end.timestamp()*1000)),
    ("DD-Mon-YYYY", start.strftime("%d-%b-%Y"), end.strftime("%d-%b-%Y")),
    ("YYYY-MM-DD",  start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")),
]:
    payload = {
        "token": "26000",
        "fromDate": from_d,
        "toDate": to_d,
        "symbol": "NIFTY 50",
        "symbolType": "Index",
        "chartType": "D",
        "timeInterval": 1,
    }
    r = session.post(
        "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
        json=payload, timeout=10,
    )
    data = r.json() if r.status_code == 200 else {}
    records = len(data.get("data", []))
    print(f"  date_fmt='{date_fmt}': status={r.status_code} records={records}")
    if records > 0:
        print(f"  First: {data['data'][0]}")
    time.sleep(1)

# ── Test 3: check if charting needs a different referer/origin ─────────────
print("\n--- With charting.nseindia.com homepage seed ---")
r_chart_home = session.get("https://charting.nseindia.com", timeout=12)
print(f"  charting home: {r_chart_home.status_code} cookies={list(session.cookies.keys())}")
time.sleep(1.5)
payload = {
    "token": "26000",
    "fromDate": int((end - timedelta(days=30)).timestamp()),
    "toDate": int(end.timestamp()),
    "symbol": "NIFTY 50",
    "symbolType": "Index",
    "chartType": "D",
    "timeInterval": 1,
}
r = session.post(
    "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
    json=payload, timeout=10,
)
data = r.json() if r.status_code == 200 else {}
records = len(data.get("data", []))
print(f"  After charting home seed: status={r.status_code} records={records}")
if records > 0:
    print(f"  First: {data['data'][0]}")
else:
    print(f"  Full response keys: {list(data.keys())}  status_field={data.get('status')}")
