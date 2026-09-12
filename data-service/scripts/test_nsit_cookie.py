#!/usr/bin/env python3
"""
Investigate how to obtain the nsit session cookie that NSE charting requires.
"""
import sys, time
sys.path.insert(0, "src")
from curl_cffi import requests as cffi_requests

session = cffi_requests.Session(impersonate="chrome110")
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
})

# Hit several NSE pages that might set nsit
pages = [
    "https://www.nseindia.com",
    "https://www.nseindia.com/market-data/live-equity-market",
    "https://www.nseindia.com/api/allIndices",
    "https://charting.nseindia.com",
]

print("Navigating NSE pages to collect cookies...\n")
for url in pages:
    try:
        session.headers.update({"Referer": "https://www.nseindia.com/"})
        r = session.get(url, timeout=12)
        print(f"{url[:60]}: {r.status_code}")
        cookies = dict(session.cookies)
        print(f"  cookies now: {list(cookies.keys())}")
        if "nsit" in cookies:
            print(f"  nsit FOUND: {cookies['nsit'][:30]}...")
    except Exception as e:
        print(f"  error: {e}")
    time.sleep(2)

# Now try historical with nsit present
print("\n\nTrying historical with all accumulated cookies...")
print(f"Full cookie set: {list(session.cookies.keys())}")

session.headers.update({
    "Content-Type": "application/json",
    "Origin": "https://charting.nseindia.com",
    "Referer": "https://charting.nseindia.com/",
})
payload = {
    "token": "26000",
    "fromDate": 1691625600,
    "toDate":   1694217600,
    "symbol": "NIFTY 50",
    "symbolType": "Index",
    "chartType": "D",
    "timeInterval": 1,
}
r = session.post(
    "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
    json=payload, timeout=12,
)
data = r.json() if r.status_code == 200 else {}
records = len(data.get("data", []))
print(f"Result: status={r.status_code} records={records}")
if records > 0:
    print(f"FIRST: {data['data'][0]}")
    print(f"LAST:  {data['data'][-1]}")
