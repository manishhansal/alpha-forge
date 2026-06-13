import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Don't eagerly load every route's module graph at dev-server startup.
    // Trades a little first-request latency for a much smaller resident
    // footprint, which matters on Windows where Turbopack + Defender +
    // Cursor's many helper node processes can exhaust the kernel commit
    // limit (STATUS_COMMITMENT_LIMIT 0xC000012D) and bash starts failing
    // every `fork()` with EAGAIN.
    preloadEntriesOnStart: false,
    // Persist Turbopack compiler artifacts between dev runs so a restart
    // (or `Ctrl+C` recovery after a fork-limit crash) doesn't re-pay the
    // multi-minute cold compile of the dashboard route graph.
    turbopackFileSystemCacheForDev: true,
  },
};

export default nextConfig;
