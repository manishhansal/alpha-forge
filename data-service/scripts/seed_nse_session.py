#!/usr/bin/env python3
"""
seed_nse_session.py — Obtain the NSE `nsit` session cookie via Playwright.

NSE's Akamai WAF uses TWO layers of bot protection:
  1. TLS fingerprinting (JA3/JA4) — bypassed by curl_cffi
  2. Behavioural token (`nsit` cookie) — requires interactive browser session

The `nsit` cookie is issued by Akamai's JavaScript challenge after it confirms
the client is behaving like a real human (mouse movements, timing, scroll events,
JS execution). curl_cffi alone cannot obtain it.

Solution: Use Playwright (headless Chromium) to navigate NSE in a real browser,
let Akamai's challenge complete, then extract the nsit cookie.

Usage:
  pip install playwright
  playwright install chromium
  python3 scripts/seed_nse_session.py

Output:
  Prints the nsit cookie value.
  Saves it to .nsit_cookie (gitignored).

Security:
  - nsit is a session token — treat it like a credential.
  - Never commit .nsit_cookie to git.
  - Tokens expire (typically 30 min); re-run this script when expired.
  - The file is read by OpenChartAdapter if present.

After running:
  from src.providers.openchart.adapter import OpenChartAdapter
  adapter = OpenChartAdapter(nsit_cookie="<value from .nsit_cookie>")
"""

import asyncio
import os
import sys
import time
from pathlib import Path

COOKIE_FILE = Path(__file__).parent.parent / ".nsit_cookie"


async def get_nsit_cookie() -> str:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("ERROR: playwright not installed.")
        print("Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    async with async_playwright() as p:
        print("Launching Chromium (headless)...")
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-http2",            # NSE blocks H2 from Chromium headless
                "--disable-web-security",
                "--ignore-certificate-errors",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            ],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/119.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            # Mask automation detection
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "sec-ch-ua": '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
                "sec-ch-ua-platform": '"Windows"',
                "sec-ch-ua-mobile": "?0",
            },
        )
        page = await context.new_page()

        # Navigate to NSE homepage to trigger Akamai challenge
        print("Navigating to NSE homepage...")
        await page.goto("https://www.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(3)  # let Akamai's JS run

        # Navigate to a page that triggers nsit issuance
        print("Navigating to live equity market...")
        await page.goto("https://www.nseindia.com/market-data/live-equity-market", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(2)

        # Navigate to charting to seed charting-specific cookies
        print("Navigating to charting platform...")
        await page.goto("https://charting.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(3)

        # Extract all cookies
        cookies = await context.cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}
        print(f"\nCookies collected: {list(cookie_dict.keys())}")

        nsit = cookie_dict.get("nsit")
        if not nsit:
            print("\nnsit cookie NOT found. Akamai challenge may not have completed.")
            print("Try running with headless=False and completing any CAPTCHA manually:")
            print("  browser = await p.chromium.launch(headless=False)")
            nsit = ""
        else:
            print(f"\nnsit cookie found: {nsit[:30]}...")

        await browser.close()
        return nsit


def main() -> None:
    nsit = asyncio.run(get_nsit_cookie())

    if nsit:
        COOKIE_FILE.write_text(nsit)
        print(f"\nSaved to: {COOKIE_FILE}")
        print("\nUse in OpenChartAdapter:")
        print(f"  adapter = OpenChartAdapter(nsit_cookie='{nsit[:20]}...')")
        print("\nOr load from file:")
        print("  nsit = Path('.nsit_cookie').read_text().strip()")
        print("  adapter = OpenChartAdapter(nsit_cookie=nsit)")
    else:
        print("\nFailed to obtain nsit cookie.")
        print("OpenChart will return SESSION_REQUIRED until nsit is available.")
        print("Alternative: use jugaad-data for EOD or Angel One/Upstox for intraday.")
        sys.exit(1)


if __name__ == "__main__":
    main()
