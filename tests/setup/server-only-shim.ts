// Empty replacement for the `server-only` runtime guard used by Next.js.
// In Vitest we need to import server modules directly, so we silently
// allow it to load instead of throwing the "this module cannot be
// imported from a Client Component module" error.
export {};
