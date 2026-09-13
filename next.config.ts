import type { NextConfig } from "next";

// ──────────────────────────────────────────────────────────────────────────────
// SECURITY GUARD — Requirement 21.6
//
// Abort the build immediately if any environment variable that would be baked
// into the client-side bundle matches a broker credential / secret pattern.
//
// Checked patterns:
//   NEXT_PUBLIC_SMARTAPI_*   — Angel One SmartAPI credentials
//   NEXT_PUBLIC_UPSTOX_*     — Upstox OAuth / token credentials
//   NEXT_PUBLIC_ENCRYPTION_* — AES-256-GCM encryption key material
//
// These values must NEVER be exposed to the browser. If you are setting one of
// these variables intentionally (there is no legitimate reason to do so), remove
// the NEXT_PUBLIC_ prefix and access the value server-side only.
// ──────────────────────────────────────────────────────────────────────────────
const CREDENTIAL_PATTERNS = [
  /^NEXT_PUBLIC_SMARTAPI_/i,
  /^NEXT_PUBLIC_UPSTOX_/i,
  /^NEXT_PUBLIC_ENCRYPTION_/i,
] as const;

const leakedVars = Object.keys(process.env).filter((key) =>
  CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key)),
);

if (leakedVars.length > 0) {
  console.error(
    "\n[AlphaForge] FATAL: Credential(s) found in NEXT_PUBLIC_* environment variables.\n" +
      "These values would be baked into the client-side bundle and exposed to browsers.\n" +
      "Offending variables:\n" +
      leakedVars.map((v) => `  - ${v}`).join("\n") +
      "\n\nRemove the NEXT_PUBLIC_ prefix and access these values server-side only.\n" +
      "See DATA_SERVICE_PRE_REFACTOR_AUDIT.md §21 and Requirements 21.6.\n",
  );
  process.exit(1);
}

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
