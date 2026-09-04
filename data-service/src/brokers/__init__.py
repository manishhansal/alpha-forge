"""
Broker API clients for the AlphaForge data-service.

This package provides authenticated broker API clients that replace
the legacy NSE direct scraping layer. The data-service now routes
market data requests through legitimate broker APIs:

  Priority 1: Angel One SmartAPI (SMARTAPI_API_KEY / SMARTAPI_CLIENT_CODE)
  Priority 2: Upstox v2/v3 API  (UPSTOX_ANALYTICS_TOKEN or UPSTOX_ACCESS_TOKEN)

Neither client performs any direct NSE data acquisition.
"""
