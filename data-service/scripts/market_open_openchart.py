#!/usr/bin/env python3
"""
market_open_openchart.py — Wait for NSE market open, then run the full
OpenChart pilot in one unattended sequence.

Sequence:
  1. Wait until NSE market is open (09:15 IST, Mon–Fri)
  2. Seed the nsit session cookie via Playwright visible Chromium
  3. Run the OpenChart pilot backfill (5 stocks × 9 timeframes)
  4. Print the pilot summary

Usage (run before 09:15 IST on a trading day, or at any time):
  python3 data-service/scripts/market_open_openchart.py

The script blocks until the market opens, then proceeds automatically.
If already inside market hours it starts immediately.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# IST helpers
# ---------------------------------------------------------------------------

_IST = timezone(timedelta(hours=5, minutes=30))

NSE_OPEN_H, NSE_OPEN_M   = 9, 15
NSE_CLOSE_H, NSE_CLOSE_M = 15, 30


def _now_ist() -> datetime:
    return datetime.now(_IST)


def _is_market_open(dt: datetime) -> bool:
    """True when dt (IST-aware) falls inside NSE regular session."""
    if dt.weekday() >= 5:               # Saturday / Sunday
        return False
    total_min = dt.hour * 60 + dt.minute
    open_min  = NSE_OPEN_H  * 60 + NSE_OPEN_M
    close_min = NSE_CLOSE_H * 60 + NSE_CLOSE_M
    return open_min <= total_min <= close_min


def _seconds_to_next_open() -> float:
    """Seconds until the next NSE open from now (0 if already open)."""
    now = _now_ist()
    if _is_market_open(now):
        return 0.0

    # Find the next Mon–Fri 09:15
    candidate = now.replace(hour=NSE_OPEN_H, minute=NSE_OPEN_M,
                            second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)

    return (candidate - now).total_seconds()


# ---------------------------------------------------------------------------
# Wait loop
# ---------------------------------------------------------------------------

def wait_for_market_open() -> None:
    secs = _seconds_to_next_open()
    if secs <= 0:
        print("NSE market is already open. Proceeding immediately.")
        return

    target = _now_ist() + timedelta(seconds=secs)
    print(f"NSE market opens at {target.strftime('%A %Y-%m-%d %H:%M IST')}")
    print(f"Waiting {secs/3600:.1f} hours ({secs/60:.0f} minutes)...")
    print("(Ctrl+C to abort)")

    # Count down with status updates every 5 minutes
    while True:
        remaining = _seconds_to_next_open()
        if remaining <= 0:
            break
        if remaining > 300:
            # Print status every 5 min
            print(f"  {_now_ist().strftime('%H:%M IST')} — "
                  f"{remaining/60:.0f} min until market open...", flush=True)
            time.sleep(300)
        else:
            # Final countdown — 10s intervals
            print(f"  {_now_ist().strftime('%H:%M:%S IST')} — "
                  f"{remaining:.0f}s remaining...", flush=True)
            time.sleep(10)

    print(f"\nMarket OPEN at {_now_ist().strftime('%H:%M:%S IST')} — starting nsit seeder...")


# ---------------------------------------------------------------------------
# nsit seeder (GUI Chromium)
# ---------------------------------------------------------------------------

async def seed_nsit() -> str:
    """Run the GUI Playwright seeder and return the nsit cookie."""
    from playwright.async_api import async_playwright

    cookie_file = Path(__file__).parent.parent / ".nsit_cookie"
    print("\nLaunching Chromium to obtain nsit cookie...")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,          # Must be visible — Akamai requires it
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
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "sec-ch-ua": '"Google Chrome";v="119", "Chromium";v="119"',
                "sec-ch-ua-platform": '"Windows"',
                "sec-ch-ua-mobile": "?0",
            },
        )
        page = await context.new_page()

        print("  Step 1: NSE homepage...")
        await page.goto("https://www.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(4)

        print("  Step 2: Equity market page (triggers Akamai challenge)...")
        await page.goto(
            "https://www.nseindia.com/market-data/live-equity-market",
            timeout=30000,
        )
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(4)

        print("  Step 3: Charting platform...")
        await page.goto("https://charting.nseindia.com", timeout=30000)
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await asyncio.sleep(4)

        # Simulate mouse movement to trigger behavioural JS
        await page.mouse.move(640, 400)
        await asyncio.sleep(0.5)
        await page.mouse.move(700, 350)
        await asyncio.sleep(0.5)
        await page.mouse.move(600, 450)
        await asyncio.sleep(2)

        cookies = await context.cookies()
        cookie_dict = {c["name"]: c["value"] for c in cookies}
        print(f"  Cookies found: {list(cookie_dict.keys())}")

        nsit = cookie_dict.get("nsit", "")

        if nsit:
            print(f"  nsit obtained: {nsit[:30]}...")
            cookie_file.write_text(nsit)
            print(f"  Saved to: {cookie_file}")
        else:
            print(
                "\n  nsit NOT found even during market hours.\n"
                "  This can happen if Akamai's challenge didn't complete.\n"
                "  Retrying in 60 seconds with a fresh page load..."
            )
            await asyncio.sleep(5)
            # Retry with a fresh navigation
            await page.goto("https://www.nseindia.com", timeout=30000)
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
            await asyncio.sleep(6)
            await page.goto(
                "https://www.nseindia.com/get-quotes/equity?symbol=RELIANCE",
                timeout=30000,
            )
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
            await asyncio.sleep(5)

            cookies = await context.cookies()
            cookie_dict = {c["name"]: c["value"] for c in cookies}
            nsit = cookie_dict.get("nsit", "")
            print(f"  Cookies after retry: {list(cookie_dict.keys())}")

            if nsit:
                print(f"  nsit obtained on retry: {nsit[:30]}...")
                cookie_file.write_text(nsit)
            else:
                print("  nsit still not found. OpenChart pilot will run as SESSION_REQUIRED.")

        await browser.close()
    return nsit


# ---------------------------------------------------------------------------
# OpenChart pilot
# ---------------------------------------------------------------------------

def run_openchart_pilot() -> int:
    """Run pilot_backfill.py --providers openchart. Returns exit code."""
    script = Path(__file__).parent / "pilot_backfill.py"
    print("\nRunning OpenChart pilot backfill...")
    result = subprocess.run(
        [sys.executable, str(script), "--providers", "openchart"],
        cwd=str(Path(__file__).parent.parent),
    )
    return result.returncode


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(
        description="Wait for NSE market open, seed nsit cookie, run OpenChart pilot"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Skip wait + nsit seeding; just run the pilot in dry-run mode to verify setup"
    )
    parser.add_argument(
        "--no-wait", action="store_true",
        help="Skip the wait (assume market is already open) — useful when running manually during market hours"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("AlphaForge OpenChart Market-Open Runner")
    print("=" * 60)
    print(f"Current time: {_now_ist().strftime('%A %Y-%m-%d %H:%M:%S IST')}")

    if args.dry_run:
        print("\nDRY-RUN mode — verifying setup without waiting or seeding.")
        print("Checking imports and script paths...")

        # Verify all dependencies are present
        ok = True
        for name in ["playwright", "curl_cffi", "openchart"]:
            try:
                __import__(name)
                print(f"  {name}: OK")
            except ImportError:
                print(f"  {name}: MISSING — install with: pip install {name}")
                ok = False

        script = Path(__file__).parent / "pilot_backfill.py"
        seed_script = Path(__file__).parent / "seed_nse_session_gui.py"
        print(f"  pilot_backfill.py: {'OK' if script.exists() else 'MISSING'}")
        print(f"  seed_nse_session_gui.py: {'OK' if seed_script.exists() else 'MISSING'}")

        nsit_file = Path(__file__).parent.parent / ".nsit_cookie"
        print(f"  .nsit_cookie: {'PRESENT' if nsit_file.exists() else 'absent (will be created on Monday)'}")

        print(f"\nScheduled run: Monday 09:20 IST")
        print(f"launchd job:   com.alphaforge.openchart (check: launchctl list | grep alphaforge)")

        if ok:
            print("\nDRY-RUN PASS — all dependencies present. Will execute at 09:20 IST Monday.")
        else:
            print("\nDRY-RUN FAIL — fix missing dependencies before Monday.")
            sys.exit(1)
        return

    # Step 1: Wait for market to open
    if not args.no_wait:
        wait_for_market_open()
    else:
        print("--no-wait: skipping wait, proceeding immediately.")

    # Step 2: Seed nsit cookie (requires open market)
    try:
        nsit = asyncio.run(seed_nsit())
    except Exception as e:
        print(f"\nnsit seeder failed: {e}")
        nsit = ""

    # Step 3: Run OpenChart pilot regardless (will show SESSION_REQUIRED if no nsit)
    rc = run_openchart_pilot()

    # Summary
    print("\n" + "=" * 60)
    print("Done.")
    print(f"nsit obtained: {'YES' if nsit else 'NO'}")
    print(f"Pilot exit code: {rc}")
    if not nsit:
        print(
            "\nIf nsit was not obtained, re-run during market hours:\n"
            "  python3 scripts/market_open_openchart.py --no-wait"
        )
    print("=" * 60)


if __name__ == "__main__":
    main()
