/**
 * Runtime-wiring regression guards (Phase 27/37).
 *
 * Prove — by inspecting NON-TEST source — that the new engines now have real
 * runtime callers via the shadow-intelligence integration, and that the safety
 * invariants cannot be bypassed. These fail CI if a future change unwires the
 * stack or reintroduces a bypass.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

function readNonTestSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        out.push({ file: p, text: fs.readFileSync(p, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}
const SOURCES = readNonTestSources();

/** Files (other than the symbol's own definition module) that reference a symbol. */
function callerFiles(symbol: string, ownModuleFragment: string): string[] {
  return SOURCES.filter(
    (s) => !s.file.includes(ownModuleFragment) && new RegExp(`\\b${symbol}\\b`).test(s.text),
  ).map((s) => s.file);
}

describe("runtime wiring — new engines are actually invoked", () => {
  it("runProfitabilityPipeline has a real runtime caller (shadow-intelligence)", () => {
    const callers = callerFiles("runProfitabilityPipeline", "profitability-engine.ts");
    expect(callers.some((f) => f.includes("shadow-intelligence.ts"))).toBe(true);
  });

  it("runAPlusFactory has a real runtime caller (shadow-intelligence)", () => {
    const callers = callerFiles("runAPlusFactory", "a-plus-signal-factory.ts");
    expect(callers.some((f) => f.includes("shadow-intelligence.ts"))).toBe(true);
  });

  it("PrismaSignalRecordStore is used by a runtime module (shadow-persistence)", () => {
    const callers = callerFiles("PrismaSignalRecordStore", "prisma-signal-record-store.ts");
    expect(callers.some((f) => f.includes("shadow-persistence.ts"))).toBe(true);
  });

  it("the canonical decision authority is used by the shadow evaluator", () => {
    const callers = callerFiles("resolveCanonicalDecision", "canonical-decision.ts");
    expect(callers.some((f) => f.includes("shadow-intelligence.ts"))).toBe(true);
  });

  it("the model-state gate is used by the shadow evaluator", () => {
    const callers = callerFiles("classifyModelState", "model-state-gate.ts");
    expect(callers.some((f) => f.includes("shadow-intelligence.ts"))).toBe(true);
  });
});

describe("no-bypass invariants (static)", () => {
  it("the NSE provider stays removed (no live provider class)", () => {
    const nse = fs.readFileSync(path.join(SRC, "lib/market-data/providers/nse.ts"), "utf8");
    expect(nse).toMatch(/NSE_PROVIDER_REMOVED_REASON/);
    expect(nse).not.toMatch(/export\s+class\s+NseProvider/);
  });

  it("SHADOW is the default signal mode (execution unchanged by default)", () => {
    const smode = fs.readFileSync(path.join(SRC, "lib/india/signal-mode.ts"), "utf8");
    expect(smode).toMatch(/DEFAULT_SIGNAL_MODE:\s*SignalMode\s*=\s*"SHADOW"/);
  });
});
