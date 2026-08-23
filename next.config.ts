import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Don't eagerly load every route's module graph at dev-server startup.
    preloadEntriesOnStart: false,
    // Persist Turbopack compiler artifacts between dev runs.
    turbopackFileSystemCacheForDev: true,
    // Disable the instant-validation worker — it throws InvariantError E1185
    // ("must run inside a WorkStore") when preloadEntriesOnStart is false,
    // which causes the dev overlay to crash with "Cannot read properties of
    // undefined (reading 'validationLevel')".
    devValidationWorker: false,
  },
};

export default nextConfig;
