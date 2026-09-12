/**
 * GET /api/v1/market/historical — alias for /api/v1/market/candles
 *
 * Provided for API discoverability. Identical implementation.
 * Consumers should prefer /candles for new integrations.
 */

export { GET } from "../candles/route";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
