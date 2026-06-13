#!/usr/bin/env node
// @ts-check
/**
 * Cursor `afterFileEdit` hook — runs the test slice that covers the file
 * the agent just edited so broken tests surface immediately in the chat.
 *
 * Behaviour
 * ─────────
 * - Reads the file edit event JSON on stdin.
 * - Maps `src/<area>/...` (and a handful of route-specific paths) to the
 *   matching `tests/<area>/` slice.
 * - Runs `npx vitest run <slice>` once. The exit code of the hook itself
 *   stays 0 so the agent never gets blocked; instead, test results are
 *   piped back as `additional_context` so the agent (and the user) can
 *   see green ✓ / red × output without leaving the chat.
 * - Skips entirely for non-source edits (markdown, configs, lockfiles,
 *   anything inside `tests/` itself, etc.) so it doesn't slow down docs
 *   work.
 *
 * The hook is fire-and-forget from the IDE's perspective: it never
 * returns `permission` or `failClosed`, so a test failure cannot block
 * the agent's tool call. Its only job is to surface the truth quickly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    // If no stdin arrives within 250ms (the hook was invoked manually),
    // fall through with an empty payload.
    setTimeout(() => resolve(buf), 250);
  });
}

function emitContext(text) {
  process.stdout.write(JSON.stringify({ additional_context: text }));
  process.exit(0);
}

function emitNoop() {
  process.stdout.write("{}");
  process.exit(0);
}

const SLICE_RULES = [
  // Domain engines
  { match: /^src\/features\//, slice: "tests/features" },
  // Pure utilities
  { match: /^src\/lib\//, slice: "tests/lib" },
  // Components
  { match: /^src\/components\//, slice: "tests/components" },
  // Route handlers
  { match: /^src\/app\/api\//, slice: "tests/api" },
  // Service layer
  { match: /^src\/services\//, slice: "tests/services" },
  // React hooks
  { match: /^src\/hooks\//, slice: "tests/hooks" },
  // Zustand stores (project uses `state/` for the store layer)
  { match: /^src\/(state|stores)\//, slice: "tests/stores" },
  // Pages — also covers redirect / not-found smoke tests
  { match: /^src\/app\/.*\/page\.tsx$/, slice: "tests/pages" },
  { match: /^src\/app\/.*not-found\.tsx$/, slice: "tests/pages" },
  // Background worker (long-running Node process — log/scheduler/config/...)
  { match: /^worker\/src\//, slice: "tests/worker" },
];

function pickSlice(relPath) {
  // Normalise to forward slashes so the regex rules above work on Windows.
  const p = relPath.replace(/\\/g, "/");
  for (const rule of SLICE_RULES) {
    if (rule.match.test(p)) return rule.slice;
  }
  // Edits to the test files themselves → re-run that one file.
  if (p.startsWith("tests/") && /\.(test|spec)\.(ts|tsx)$/.test(p)) {
    return p;
  }
  // Top-level config / vitest setup → run the whole suite, but only when
  // those are touched (rare).
  if (
    p === "vitest.config.ts" ||
    p.startsWith("tests/setup/") ||
    p === "tsconfig.json"
  ) {
    return "";
  }
  return null;
}

/**
 * Try to find a single matching `tests/<slice>/<...>.test.{ts,tsx}` file
 * for the edited source path so we run the smallest possible target. We
 * look for any test filename that contains a substring of the source
 * basename — handles both `utils.ts` → `utils.test.ts` and
 * `best-time-banner.tsx` → `best-time-banner.test.tsx`.
 *
 * If nothing matches we return null and the caller falls back to running
 * the whole slice.
 */
function findExactTestTarget(repoRoot, slice, sourceRelPath) {
  const sliceAbs = path.resolve(repoRoot, slice);
  if (!existsSync(sliceAbs)) return null;

  const base = path.basename(sourceRelPath).replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!base || base === "index") return null;

  let testFiles;
  try {
    testFiles = readdirSync(sliceAbs);
  } catch {
    return null;
  }

  // Direct match first (fastest, exact basename).
  const direct = testFiles.find(
    (f) => f === `${base}.test.ts` || f === `${base}.test.tsx`,
  );
  if (direct) return `${slice}/${direct}`;

  // Substring match against the source basename. We pick the shortest
  // matching test filename so e.g. `utils.test.ts` beats
  // `utils-extra.test.ts` for a `utils.ts` edit.
  const candidates = testFiles
    .filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))
    .filter((f) => f.includes(base) || base.includes(f.replace(/\.(test|spec)\.(ts|tsx)$/, "")))
    .sort((a, b) => a.length - b.length);

  if (candidates.length > 0) return `${slice}/${candidates[0]}`;
  return null;
}

function relativeFrom(repoRoot, abs) {
  if (!abs) return "";
  return path.relative(repoRoot, abs).replace(/\\/g, "/");
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return emitNoop();

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return emitNoop();
  }

  // The afterFileEdit payload includes a `file_path` (or `paths`) — try a
  // few shapes so we stay forward-compatible with future Cursor releases.
  const repoRoot = process.cwd();
  const candidatePaths = []
    .concat(event?.file_path ? [event.file_path] : [])
    .concat(Array.isArray(event?.paths) ? event.paths : [])
    .concat(event?.tool_input?.file_path ? [event.tool_input.file_path] : [])
    .concat(event?.tool_input?.path ? [event.tool_input.path] : [])
    .map((p) => relativeFrom(repoRoot, p))
    .filter(Boolean);

  if (candidatePaths.length === 0) return emitNoop();

  // Skip generated / non-source edits.
  const sourceFiles = candidatePaths.filter(
    (p) =>
      !/^(node_modules|\.next|coverage|prisma\/migrations|public)\//.test(p) &&
      /\.(ts|tsx|js|jsx)$/.test(p),
  );
  if (sourceFiles.length === 0) return emitNoop();

  const slices = new Set();
  const exactTargets = new Set();
  let runFullSuite = false;
  for (const file of sourceFiles) {
    const slice = pickSlice(file);
    if (slice === null) continue; // No mapping → skip this file.
    if (slice === "") {
      runFullSuite = true;
      break;
    }
    // If the slice is a literal test path (we edited a test directly), use it.
    if (slice.startsWith("tests/") && slice.endsWith(".test.ts")) {
      exactTargets.add(slice);
      continue;
    }
    if (slice.startsWith("tests/") && slice.endsWith(".test.tsx")) {
      exactTargets.add(slice);
      continue;
    }
    // For source-file edits, look for a single matching test file first.
    const exact = findExactTestTarget(repoRoot, slice, file);
    if (exact) exactTargets.add(exact);
    else slices.add(slice);
  }

  if (!runFullSuite && slices.size === 0 && exactTargets.size === 0) {
    return emitNoop();
  }

  const targets = runFullSuite
    ? []
    : [...exactTargets, ...slices];
  const args = ["vitest", "run", "--no-coverage", "--silent=passed-only", ...targets];

  const t0 = Date.now();
  const proc = spawnSync("npx", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    timeout: 110_000,
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();
  const ok = proc.status === 0;
  const sliceLabel = runFullSuite
    ? "<full suite>"
    : targets.length > 3
      ? `${targets.length} targets`
      : targets.join(", ");

  // Only inject context when something useful happened (success summary
  // or visible failure) — this keeps the chat clean for trivial edits.
  const summaryLines = [
    `[after-edit-tests] slice=${sliceLabel} status=${ok ? "PASS" : "FAIL"} elapsed=${elapsedSec}s`,
  ];
  if (!ok) {
    summaryLines.push("--- vitest stderr ---");
    summaryLines.push(stderr.slice(-4_000));
    summaryLines.push("--- vitest stdout ---");
    summaryLines.push(stdout.slice(-4_000));
    summaryLines.push(
      "TDD reminder: write/adjust the failing test first, then fix the code so this slice goes green again.",
    );
  } else {
    // Cap at the trailing summary lines so we don't flood the chat.
    const tail = stdout.split(/\r?\n/).slice(-6).join("\n");
    summaryLines.push(tail);
  }
  emitContext(summaryLines.join("\n"));
}

main().catch(() => emitNoop());
