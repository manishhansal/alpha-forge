"""
Duplicate-tick protection on the publish path (spec §27).

Uses an injected fake scraper and monkeypatches _publish_tick so we can count
how many ticks actually reach Redis. Confirms that a repeated identical quote
(same symbol / event-time / ltp) is deduplicated and published only once.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.publisher.tick_publisher import TickPublisher
from src.schemas import MDQuote
from src.core.deduplication import event_dedup


def _quote(sym: str, ltp: float, lt: str) -> MDQuote:
    return MDQuote(
        symbol=sym,
        token=sym,
        exchange="NSE",
        ltp=ltp,
        lastTradeTime=lt,
        provider="scrapling",
        fetchedAt=datetime.now(timezone.utc).isoformat(),
    )


class _FakeScraper:
    def __init__(self, batches: list[list[MDQuote]]) -> None:
        self._batches = batches
        self._i = 0

    async def get_quotes(self, symbols):
        batch = self._batches[min(self._i, len(self._batches) - 1)]
        self._i += 1
        return batch


@pytest.fixture(autouse=True)
def _reset_dedup():
    event_dedup.reset()
    yield
    event_dedup.reset()


async def test_duplicate_tick_published_once(monkeypatch):
    # Same NIFTY tick (identical lastTradeTime + ltp) returned twice.
    lt = "2026-09-07T10:00:00Z"
    pub = TickPublisher(scraper=_FakeScraper([[_quote("NIFTY", 23850.0, lt)]]))
    pub._symbols = ["NIFTY"]

    published: list[str] = []

    async def fake_publish(tick):
        published.append(tick.symbol)
        return True

    monkeypatch.setattr(pub, "_publish_tick", fake_publish)

    # First poll → publishes once.
    await pub._poll_and_publish()
    # Second poll → identical quote → deduplicated, NOT published again.
    await pub._poll_and_publish()

    assert published == ["NIFTY"], published
    assert event_dedup.duplicate_count >= 1


async def test_distinct_ticks_both_published(monkeypatch):
    lt1 = "2026-09-07T10:00:00Z"
    lt2 = "2026-09-07T10:00:05Z"
    pub = TickPublisher(
        scraper=_FakeScraper([[_quote("NIFTY", 23850.0, lt1)], [_quote("NIFTY", 23851.0, lt2)]])
    )
    pub._symbols = ["NIFTY"]

    published: list[float] = []

    async def fake_publish(tick):
        published.append(tick.ltp)
        return True

    monkeypatch.setattr(pub, "_publish_tick", fake_publish)

    await pub._poll_and_publish()
    await pub._poll_and_publish()

    # Two genuinely different observations → both published.
    assert published == [23850.0, 23851.0], published
