#!/usr/bin/env python3
"""
Test OpenChart with curl_cffi session injection.
NSE uses Akamai WAF with TLS fingerprinting — standard Python requests
gets blocked because it uses OpenSSL. curl_cffi impersonates Chrome's
BoringSSL fingerprint, bypassing the WAF.
"""
import sys, time, json
from datetime import datetime, timedelta

sys.path.insert(0, "src")
from curl_cffi import requests as cffi_requests

# ── Build a curl_cffi session that impersonates Chrome ──────────────────────
def make_nse_session() -> cffi_requests.Session:
    session = cffi_requests.Session(impersonate="chrome110")
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/119.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json",
        "Origin": "https://charting.nseindia.com",
        "Referer": "https://charting.nseindia.com/",
    })
    # Seed WAF cookies from homepage
    print("Seeding WAF cookies from NSE homepage...")
    try:
        r = session.get("https://www.nseindia.com", timeout=12)
        print(f"  Homepage: {r.status_code}  cookies: {list(session.cookies.keys())}")
    except Exception as e:
        print(f"  Homepage error: {e}")
    time.sleep(2)
    return session

# ── Direct test of the endpoints OpenChart uses ─────────────────────────────
def test_search(session, symbol="RELIANCE", segment="EQ"):
    print(f"\nTesting search: {symbol} in {segment}...")
    payload = {"symbol": symbol, "segment": segment}
    r = session.post(
        "https://charting.nseindia.com/v1/exchanges/symbolsDynamic",
        json=payload, timeout=12,
    )
    print(f"  Status: {r.status_code}")
    if r.status_code == 200:
        try:
            data = r.json()
            print(f"  status={data.get('status')}  records={len(data.get('data',[]))}")
            if data.get("data"):
                print(f"  First: {data['data'][0]}")
            return data.get("data", [])
        except Exception as e:
            print(f"  JSON parse error: {e}  text: {r.text[:200]}")
    else:
        print(f"  Error response: {r.text[:200]}")
    return []

def test_historical_direct(session, token, symbol, sym_type, interval="1d"):
    print(f"\nTesting historical: {symbol} (token={token}) interval={interval}...")
    end = datetime.now()
    start = end - timedelta(days=10)
    interval_map = {
        "1m": (1, "I"), "5m": (5, "I"), "10m": (10, "I"),
        "15m": (15, "I"), "30m": (30, "I"), "1h": (60, "I"),
        "1d": (1, "D"), "1w": (1, "W"), "1M": (1, "M"),
    }
    ti, ct = interval_map.get(interval, (1, "D"))
    payload = {
        "token": str(token),
        "fromDate": int(start.timestamp()),
        "toDate": int(end.timestamp()),
        "symbol": symbol,
        "symbolType": sym_type,
        "chartType": ct,
        "timeInterval": ti,
    }
    r = session.post(
        "https://charting.nseindia.com/v1/charts/symbolHistoricalData",
        json=payload, timeout=12,
    )
    print(f"  Status: {r.status_code}")
    if r.status_code == 200:
        try:
            data = r.json()
            print(f"  status={data.get('status')}  records={len(data.get('data',[]))}")
            if data.get("data"):
                print(f"  First candle: {data['data'][0]}")
            return data.get("data", [])
        except Exception as e:
            print(f"  JSON parse error: {e}  text: {r.text[:200]}")
    else:
        print(f"  Error: {r.text[:200]}")
    return []


if __name__ == "__main__":
    session = make_nse_session()

    # Search for NIFTY 50 (index — known working scrip code 26000)
    idx_results = test_search(session, "NIFTY 50", "IDX")
    time.sleep(1.5)

    # Search for RELIANCE (equity)
    eq_results = test_search(session, "RELIANCE", "EQ")
    time.sleep(1.5)

    # Historical for NIFTY 50 with known token=26000, type=Index
    test_historical_direct(session, 26000, "NIFTY 50", "Index", "1d")
    time.sleep(1.5)

    # Historical for RELIANCE with known token=2885, type=Equity
    test_historical_direct(session, 2885, "RELIANCE-EQ", "Equity", "1d")
    time.sleep(1.5)

    # If equity search returns results, test with real token
    if eq_results:
        token = eq_results[0].get("scripcode")
        sym   = eq_results[0].get("symbol")
        stype = eq_results[0].get("type")
        print(f"\nUsing search result: {sym} token={token} type={stype}")
        test_historical_direct(session, token, sym, stype, "1d")
