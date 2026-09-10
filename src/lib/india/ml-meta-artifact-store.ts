/**
 * ML Meta-Decision Artifact Store
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Loads the frozen `MetaModelArtifact` used by the India signal builder at
 * inference time. The artifact is produced OFFLINE by `trainMetaModel` on OOS
 * outcomes and persisted (e.g. to the India cache / object store). Until a
 * trained artifact is available this returns `defaultMetaArtifact()` — the safe
 * fallback whose model contributions are all `addsValue = false`, so the ranker
 * boost is suppressed and probabilities shrink toward the global prior.
 *
 * The loader is process-memoised (the artifact is immutable once frozen). This
 * module is intentionally tiny and side-effect-light so the builder can call it
 * cheaply every cycle.
 */

import type { MetaModelArtifact } from "./ml-meta-decision";
import { defaultMetaArtifact } from "./ml-meta-training";

let _cached: MetaModelArtifact | null = null;
let _cachedAtMs = 0;
const RELOAD_TTL_MS = 60 * 60 * 1000; // re-check hourly

/**
 * Resolve the current meta artifact. Override the resolver via
 * `setIndiaMetaArtifactResolver` when wiring a real persistence backend
 * (cache / DB / object store); otherwise the safe default is returned.
 */
type Resolver = () => Promise<MetaModelArtifact | null>;
let _resolver: Resolver | null = null;

/** Wire a persistence backend (called at boot; keeps this module I/O-agnostic). */
export function setIndiaMetaArtifactResolver(resolver: Resolver): void {
  _resolver = resolver;
  _cached = null;
  _cachedAtMs = 0;
}

/** Load (and memoise) the frozen meta artifact, falling back to the safe default. */
export async function loadIndiaMetaArtifact(nowMs = Date.now()): Promise<MetaModelArtifact> {
  if (_cached && nowMs - _cachedAtMs < RELOAD_TTL_MS) return _cached;
  let artifact: MetaModelArtifact | null = null;
  if (_resolver) {
    try {
      artifact = await _resolver();
    } catch {
      artifact = null;
    }
  }
  const resolved: MetaModelArtifact = artifact ?? defaultMetaArtifact();
  _cached = resolved;
  _cachedAtMs = nowMs;
  return resolved;
}

/** Test/hot-reload hook: clear the memoised artifact. */
export function resetIndiaMetaArtifactCache(): void {
  _cached = null;
  _cachedAtMs = 0;
}
