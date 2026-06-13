/**
 * Journal-related constants that need to be importable from BOTH server
 * components (`page.tsx`) and client components (`journal-data-context`).
 *
 * Kept in its own file so neither `import "server-only"` (in
 * `journal.ts`) nor `"use client"` (in the data context) leaks into the
 * other side of the boundary. Turbopack sometimes erases primitive
 * exports that cross a `"use client"` boundary into a server module,
 * which is why this lives here instead of in either of those files.
 */

/** Default page size for the paginated journal table. */
export const JOURNAL_PAGE_SIZE = 10;
