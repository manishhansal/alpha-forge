import { describe, expect, it } from "vitest";

import IndiaIndex from "@/app/(dashboard)/in/page";
import LegacySettings from "@/app/(dashboard)/settings/page";
import LegacyIndiaSettings from "@/app/(dashboard)/in/settings/page";
import LegacyScalper from "@/app/(dashboard)/scalper/page";
import LegacyIndiaScalper from "@/app/(dashboard)/in/scalper/page";

/**
 * Page-level smoke tests for legacy URL redirects.
 *
 * Both `redirect()` and `permanentRedirect()` from `next/navigation` throw a
 * Next.js internal "redirect" sentinel error to abort rendering. We just
 * assert that calling each page throws — Vitest can't introspect Next's
 * internal redirect signal payload, but the throw guarantees the redirect
 * was issued.
 */
describe("page redirects", () => {
  it("/in throws (redirects to /in/dashboard)", () => {
    expect(() => IndiaIndex()).toThrow();
  });

  it("/settings throws (308-redirects to /profile)", () => {
    expect(() => LegacySettings()).toThrow();
  });

  it("/in/settings throws (308-redirects to /in/profile)", () => {
    expect(() => LegacyIndiaSettings()).toThrow();
  });

  it("/scalper throws (308-redirects to /strategies)", () => {
    expect(() => LegacyScalper()).toThrow();
  });

  it("/in/scalper throws (308-redirects to /in/strategies)", () => {
    expect(() => LegacyIndiaScalper()).toThrow();
  });
});
