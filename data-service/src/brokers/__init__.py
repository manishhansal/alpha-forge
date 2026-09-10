"""
Broker API clients for the AlphaForge data-service.

ACCURATE SCOPE (corrected per data forensic audit RCA-D08):

Only ONE authenticated broker client is implemented in this package today:

  Upstox v2/v3 API  (UPSTOX_ANALYTICS_TOKEN or UPSTOX_ACCESS_TOKEN)
    - see ``upstox_client.py`` / ``upstox_instruments.py``

There is currently NO Angel One SmartAPI client and NO Yahoo client in this
package. Those providers exist only in the TypeScript market-data layer
(``src/lib/market-data/providers``) and in enum/label form here. The intended
provider hierarchy (data-service → Angel One → Upstox → Yahoo) is orchestrated
by the TypeScript ``ProviderRegistry``; this Python service only makes an
individual provider call resilient (retry / backoff / Retry-After).

IMPORTANT — this service DOES perform direct NSE/BSE acquisition:
The primary quote / historical / option-chain / instrument-master sources in
``scrapers/`` fetch directly from ``nseindia.com`` / ``bseindia.com`` (fronted
by the ``scrapling`` provider id). The TypeScript layer forbids direct NSE
scraping (Absolute Rule 10); that rule applies to the TypeScript layer, not to
this acquisition service. Do not claim "no direct NSE acquisition" — it is not
true of this service.
"""
