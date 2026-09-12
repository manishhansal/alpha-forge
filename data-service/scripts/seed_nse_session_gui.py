#!/usr/bin/env python3
"""
seed_nse_session_gui.py — Obtain NSE nsit cookie via visible Chromium.

Akamai's behavioural JS challenge (nsit) requires real mouse interactions
in a visible browser window. This script opens a real Chromium window,
navigates NSE, waits for nsit to be issued (with extended wait time), then
extracts and saves it.

Usage: python3 scripts/seed_nse_session_gui.py
"""
import asyncio
import sys
from pathlib import Path

COOKIE_FILE = Path(__file__).parent.parent / ".nsit_cookie"


async def get_nsit_gui() -> str:
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        print("Launching visible Chromium window...")
        browser = await p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-http2",
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
        )
        page = await context.new_page()

        print("Step 1: Opening NSE homepage (stay on the page for 5 seconds)...")
        await page.goto("https://www.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        # Wait for behavioural challenge to complete
        await asyncio.sleep(5)

        print("Step 2: Navigating to equity market page...")
        await page.goto(
            "https://www.nseindia.com/market-data/live-equity-market",
            timeout=30000,
        )
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(4)

        print("Step 3: Navigating to charting platform...")
        await page.goto("https://charting.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(3)

        cookies = await context.cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}
        print(f"\nCookies found: {list(cookie_dict.keys())}")

        nsit = cookie_dict.get("nsit")
        if nsit:
            print(f"nsit found: {nsit[:30]}...")
        else:
            # Final attempt: trigger more page interaction
            print("nsit not found yet. Trying additional page interaction...")
            await page.mouse.move(640, 400)
            await asyncio.sleep(1)
            await page.mouse.move(700, 450)
            await asyncio.sleep(2)

            cookies = await context.cookies()
            cookie_dict = {c["name"]: c["value"] for c in cookies}
            nsit = cookie_dict.get("nsit")
            if nsit:
                print(f"nsit found after interaction: {nsit[:30]}...")
            else:
                print(f"\nnsit NOT obtained. Cookies: {list(cookie_dict.keys())}")
                print("Akamai's nsit is only issued during live market sessions.")
                print("Try running this script during NSE market hours (09:15-15:30 IST).")

        await browser.close()
        return nsit or ""


def main():
    nsit = asyncio.run(get_nsit_gui())
    if nsit:
        COOKIE_FILE.write_text(nsit)
        print(f"\nSaved to: {COOKIE_FILE}")
        print("\nRun the pilot:")
        print("  python3 scripts/pilot_backfill.py --providers openchart")
    else:
        print("\nFailed. Try during NSE market hours (09:15-15:30 IST Mon-Fri).")
        sys.exit(1)


if __name__ == "__main__":
    main()
