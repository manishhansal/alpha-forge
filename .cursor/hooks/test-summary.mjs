#!/usr/bin/env node
// @ts-check
/**
 * Cursor `stop` hook — runs the full Vitest suite once when the agent
 * finishes a turn so the user sees a green/red summary even if the
 * per-edit hook only re-ran a slice.
 *
 * The hook never blocks the agent; it just appends a one-line summary to
 * the chat so the user knows whether the codebase is currently green.
 */
import { spawnSync } from "node:child_process";

function emitContext(text) {
  process.stdout.write(JSON.stringify({ additional_context: text }));
  process.exit(0);
}

function emitNoop() {
  process.stdout.write("{}");
  process.exit(0);
}

function main() {
  const t0 = Date.now();
  const proc = spawnSync(
    "npx",
    ["vitest", "run", "--no-coverage", "--silent=passed-only"],
    {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 25_000,
    },
  );
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  // null status = killed by timeout / signal — don't pretend we know.
  if (proc.status === null) return emitNoop();

  const ok = proc.status === 0;
  const out = (proc.stdout ?? "") + (proc.stderr ?? "");
  const tail = out
    .split(/\r?\n/)
    .slice(-3)
    .join(" | ")
    .replace(/\s+/g, " ");
  emitContext(
    `[stop-suite] full vitest run ${ok ? "PASS" : "FAIL"} (${elapsedSec}s) — ${tail}`,
  );
}

main();
